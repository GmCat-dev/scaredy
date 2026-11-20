"""Scaredy GmCat rooms (Claude, 2026-11-19; moved here from GmCat Drop's "Direct send" preview).

The file never lands on our server. The sender's page keeps it; each receiver gets it straight from that page.
This module only helps the two browsers find each other ("signalling"), and, when the sender picks the encrypted relay,
passes encrypted pieces from one browser to the other without keeping them. Nothing is written to disk: rooms live in
memory and disappear when the sender stops sharing (at once), closes the page (after LEAVE_GRACE seconds, so a refresh
can pick the same link back up) or stops checking in (about 30 seconds).

The file is encrypted in the sender's browser with a key that is only in the part of the link after "#", which browsers
never send to a server, so we can't read it either way (relay or direct).

  POST /api/rooms                     {mode: "direct"|"relay"|"short", key (short only), fallback} -> {room, token}
                                      fallback (direct/short): if one person's network blocks the direct connection,
                                      the sender's page switches just that person to the relay by itself (v4)
                                      "short" = a short link with no key in it: the key is kept in memory only while the
                                      room lives and handed to receivers when they join (the file still goes directly).
  POST /api/<room>/join               -> {peer, token, mode}            (a receiver opened the link)
  POST /api/<room>/send               {token, to: "sender"|<peer>, data}  a small signalling message
                                      data {type: "relay"} from the sender = this person now gets pieces through the
                                      relay (Direct couldn't get through for them; v4, 2026-11-20)
  GET  /api/<room>/poll?token=        waits up to 20 s for messages -> {msgs}
  POST /api/<room>/close              {token}  the sender stopped sharing (at once)
                                      {token, soon: true}  the sender's page is unloading (refresh or close): the room
                                      waits LEAVE_GRACE seconds for the same page to come back, then closes
  POST /api/<room>/resume             {token}  the sender's page came back after a refresh: the room carries on, the
                                      people already connected are told to reconnect ("again"), relay pieces restart
  POST /api/<room>/relay/<peer>/<n>   raw encrypted piece n (sender; X-Scaredy-Token); 429 = wait, window full
  GET  /api/<room>/relay/<peer>/<n>   waits up to 20 s for piece n (receiver; ?token=). Asking for n also forgets every
                                      piece before n, so a piece cut off by a dropped connection can be asked for again
                                      and each piece is deleted as soon as the next one is asked for (v5)

Clean-up (v5, 2026-11-20, like Drop's cleanup loop): a background sweep every CLEAN_EVERY seconds deletes closed or
abandoned rooms with any relay pieces still in them, people who stopped checking in, and old rate-limit entries, even
when nobody else visits. A receiver who leaves ("bye") is removed at once, with anything waiting for them.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
ROOM_RE = re.compile(r"^[%s]{8}$" % ALPHABET)
PEER_RE = re.compile(r"^p[0-9a-f]{8}$")
SENDER_GONE = 30          # seconds without the sender's page checking in: the room closes (its polls come every <= 20 s)
PEER_GONE = 90
LEAVE_GRACE = 15          # seconds a refreshing sender page has to come back before its link closes (v3, 2026-11-20)
POLL_WAIT = 20
MAX_MSG = 64 * 1024       # one signalling message
MAX_QUEUE = 200
MAX_PEERS = 20            # receivers per room
JOINS_PER_MINUTE = 20     # per visitor: short codes can't be guessed by trying lots of them
ROOMS_PER_VISITOR = 5
MAX_ROOMS = 2000          # whole service, fair use
WINDOW = 8                # relay: pieces waiting for one receiver at most (8 x 1 MB)
MAX_PIECE = 1100 * 1024
RELAY_MAX_BYTES = 6 * 1024 ** 3   # per room, so the relay can't be used as an open pipe forever
RELAY_DAY_BYTES = 200 * 1024 ** 3   # whole service per day (fair use); then the relay pauses until tomorrow (UTC)
CLEAN_EVERY = int(os.environ.get("SCAREDY_CLEAN_EVERY", "30"))   # seconds between background sweeps

ROOMS = {}
JOINS = {}                # visitor -> recent join times (memory only)
LOCK = threading.Condition()
STATS = {"rooms": 0, "relay_bytes": 0}


def _h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _now():
    return time.time()


def _dead(room, t):
    return room["closed"] or t - room["sender_seen"] > SENDER_GONE or (room["leaving"] and t - room["leaving"] > LEAVE_GRACE)


def _sweep(t):
    for rid in [r for r, room in ROOMS.items() if _dead(room, t)]:
        del ROOMS[rid]
    for room in ROOMS.values():
        for pid in [p for p, peer in room["peers"].items() if t - peer["seen"] > PEER_GONE]:
            del room["peers"][pid]


def sweep_now():
    """One clean-up pass (the background loop runs this every CLEAN_EVERY seconds)."""
    t = _now()
    with LOCK:
        _sweep(t)
        for k in [k for k, xs in JOINS.items() if not xs or xs[-1] < t - 60]:
            del JOINS[k]
        LOCK.notify_all()          # waiting polls/relay reads notice their room has gone
        return len(ROOMS)


def cleanup_loop():
    while True:
        time.sleep(CLEAN_EVERY)
        try:
            sweep_now()
        except Exception as exc:   # keep the loop alive
            print("cleanup error: %s" % exc, flush=True)


def start_cleanup():
    threading.Thread(target=cleanup_loop, daemon=True).start()


def _who(room, token):
    """'sender', a peer id, or None."""
    if not token:
        return None
    th = _h(token)
    if hmac.compare_digest(room["sender_token"], th):
        return "sender"
    for pid, peer in room["peers"].items():
        if hmac.compare_digest(peer["token"], th):
            return pid
    return None


def _queue(room, who):
    return room["sender_q"] if who == "sender" else room["peers"][who]["q"]


def handle(h, method, parts):
    """h is the Drop request handler. Returns True when it answered the request."""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(h.path).query)
    t = _now()
    if method == "POST" and parts == ["api", "rooms"]:
        try:
            d = h.read_json()
        except ValueError:
            return h.error(400, "Bad request.") or True
        mode = d.get("mode") if d.get("mode") in ("relay", "short") else "direct"
        key = d.get("key") if mode == "short" else None
        fallback = bool(d.get("fallback")) and mode != "relay"
        if mode == "short" and not (isinstance(key, str) and re.match(r"^[A-Za-z0-9_-]{16,64}$", key)):
            h.error(400, "Bad request.")
            return True
        v = h.visitor()
        with LOCK:
            _sweep(t)
            if sum(1 for r in ROOMS.values() if r["visitor"] == v) >= ROOMS_PER_VISITOR:
                h.error(429, "You're already sharing %d files. Stop one first." % ROOMS_PER_VISITOR)
                return True
            if len(ROOMS) >= MAX_ROOMS:
                h.error(503, "Scaredy GmCat is very busy right now. Please try again in a few minutes.")
                return True
            rid = "".join(secrets.choice(ALPHABET) for _ in range(8))
            while rid in ROOMS:
                rid = "".join(secrets.choice(ALPHABET) for _ in range(8))
            token = secrets.token_urlsafe(24)
            ROOMS[rid] = {"id": rid, "mode": mode, "sender_token": _h(token), "sender_seen": t, "created": t, "visitor": v,
                          "closed": False, "sender_q": [], "peers": {}, "relay_bytes": 0, "key": key,
                          "leaving": 0, "sender_gen": 0, "fallback": fallback}
            STATS["rooms"] += 1
        h.send_json(201, {"room": rid, "token": token, "mode": mode})
        return True

    if len(parts) < 3 or parts[0] != "api" or not ROOM_RE.match(parts[1]):
        return False
    parts = ["api", "direct"] + parts[1:]          # same shape as before: api, direct, room, action, ...
    rid, action = parts[2], parts[3]
    if method == "POST" and action == "join":
        # every attempt counts, found or not, so short codes can't be guessed by trying lots of them
        v = h.visitor()
        with LOCK:
            JOINS[v] = [x for x in JOINS.get(v, []) if x > t - 60] + [t]
            if len(JOINS) > 20000:
                for k in [k for k, xs in JOINS.items() if xs[-1] < t - 60]:
                    del JOINS[k]
            if len(JOINS[v]) > JOINS_PER_MINUTE:
                h.error(429, "Too many links opened. Wait a minute and try again.")
                return True
    with LOCK:
        _sweep(t)
        room = ROOMS.get(rid)
    if not room:
        h.send_json(404, {"error": "The sender isn't sharing this any more. Ask them for a new link.", "code": "gone"})
        return True

    if method == "POST" and action == "join" and len(parts) == 4:
        with LOCK:
            if len(room["peers"]) >= MAX_PEERS:
                h.error(429, "Too many people are connected to this link right now. Try again in a minute.")
                return True
            pid, token = "p" + secrets.token_hex(4), secrets.token_urlsafe(24)
            room["peers"][pid] = {"token": _h(token), "seen": t, "q": [], "relay": {}, "relay_next": 0, "epoch": 0}
            room["sender_q"].append({"type": "join", "peer": pid})
            LOCK.notify_all()
        out = {"peer": pid, "token": token, "mode": room["mode"], "fallback": room.get("fallback", False)}
        if room["mode"] == "short":
            out["key"] = room["key"]        # short links carry no key; it lives only in this room's memory
        h.send_json(200, out)
        return True

    if method == "POST" and action in ("send", "close", "resume") and len(parts) == 4:
        try:
            d = h.read_json(MAX_MSG + 1024)
        except ValueError:
            return h.error(413, "That message is too big.") or True
        with LOCK:
            who = _who(room, d.get("token"))
            if not who:
                h.error(403, "Not allowed.")
                return True
            if action == "close":
                if who == "sender":
                    if d.get("soon"):
                        room["leaving"] = _now()       # a refresh comes back within LEAVE_GRACE; a closed page doesn't
                    else:
                        room["closed"] = True
                    LOCK.notify_all()
                h.send_json(200, {"ok": True})
                return True
            if action == "resume":
                if who != "sender":
                    h.error(403, "Not allowed.")
                    return True
                room["leaving"], room["sender_seen"] = 0, _now()
                room["sender_gen"] += 1                  # the old page's poll (if still waiting) steps aside
                for peer in room["peers"].values():      # everyone connected reconnects to the new page
                    peer["epoch"] += 1
                    peer["relay"] = {}
                    peer["q"].append({"from": "sender", "data": {"type": "again", "epoch": peer["epoch"]}})
                room["sender_q"] = [{"type": "join", "peer": pid, "epoch": room["peers"][pid]["epoch"],
                                     "via": room["peers"][pid].get("via", "")} for pid in sorted(room["peers"])]
                LOCK.notify_all()
                h.send_json(200, {"ok": True, "mode": room["mode"]})
                return True
            to = d.get("to")
            if who == "sender":
                if to not in room["peers"]:
                    h.send_json(410, {"error": "That person has left.", "code": "peer_gone"})
                    return True
            elif to != "sender":
                h.error(403, "Not allowed.")
                return True
            box = _queue(room, to)
            if who == "sender" and isinstance(d.get("data"), dict) and d["data"].get("type") == "relay":
                room["peers"][to]["via"] = "relay"       # Direct was blocked for this person: the relay may carry theirs
            if len(box) >= MAX_QUEUE:
                h.error(429, "Slow down.")
                return True
            box.append({"from": who, "data": d.get("data")})
            if who != "sender" and isinstance(d.get("data"), dict) and d["data"].get("type") == "bye":
                del room["peers"][who]                   # they closed the page: forget them and anything waiting for them
            LOCK.notify_all()
        h.send_json(200, {"ok": True})
        return True

    if method == "GET" and action == "poll" and len(parts) == 4:
        token = (q.get("token") or [""])[0]
        deadline = _now() + POLL_WAIT
        with LOCK:
            who = _who(room, token)
            if not who:
                h.error(403, "Not allowed.")
                return True
            gen = room["sender_gen"]
            if who == "sender":
                room["sender_seen"] = _now()      # once per poll: a closed page stops polling, so this goes stale
                room["leaving"] = 0               # a page that is polling is still here
            while True:
                now = _now()
                if who != "sender" and who in room["peers"]:
                    room["peers"][who]["seen"] = now
                if _dead(room, now):
                    room["closed"] = True
                if who == "sender" and room["sender_gen"] != gen:
                    h.send_json(409, {"error": "This link is being shared from another page now.", "code": "moved"})
                    return True
                if room["closed"] or rid not in ROOMS or (who != "sender" and who not in room["peers"]):
                    h.send_json(404, {"error": "The sender isn't sharing this any more. Ask them for a new link.", "code": "gone"})
                    return True
                box = _queue(room, who)
                if box or now >= deadline:
                    msgs, box[:] = list(box), []
                    break
                LOCK.wait(min(5, deadline - now))
        out = {"msgs": msgs}
        if who == "sender":
            out["peers"] = sorted(room["peers"])
        h.send_json(200, out)
        return True

    if action == "relay" and len(parts) == 6 and PEER_RE.match(parts[4]) and parts[5].isdigit():
        pid, n = parts[4], int(parts[5])
        if room["mode"] != "relay" and (room["peers"].get(pid) or {}).get("via") != "relay":
            h.error(400, "This link doesn't use the relay.")
            return True
        if method == "POST":
            size = int(h.headers.get("Content-Length") or 0)
            if size <= 0 or size > MAX_PIECE:
                h.drain()
                h.error(413, "Piece too big.")
                return True
            with LOCK:
                ok = _who(room, h.headers.get("X-Scaredy-Token", "")) == "sender"
                peer = room["peers"].get(pid)
                full = peer is not None and len(peer["relay"]) >= WINDOW
                day = time.strftime("%Y-%m-%d", time.gmtime())
                if STATS.get("day") != day:
                    STATS["day"], STATS["day_bytes"] = day, 0
                over = room["relay_bytes"] + size > RELAY_MAX_BYTES or STATS["day_bytes"] + size > RELAY_DAY_BYTES
            if not ok or peer is None or full or over:
                h.drain()
                if not ok:
                    h.error(403, "Not allowed.")
                elif peer is None:
                    h.send_json(410, {"error": "That person has left.", "code": "peer_gone"})
                elif over:
                    h.error(413, "The relay has reached its fair-use limit for now. Try Direct, or try again later.")
                else:
                    h.send_json(429, {"error": "wait", "code": "window"})
                return True
            body = h.rfile.read(size)
            ep = h.headers.get("X-Scaredy-Epoch", "0")
            with LOCK:
                peer = room["peers"].get(pid)
                if len(body) != size or peer is None or str(peer["epoch"]) != ep:
                    # cut off mid-upload, or sent by the sender's page from before a refresh: never hand it over
                    h.send_json(409, {"error": "stale", "code": "epoch"})
                    return True
                room["sender_seen"] = _now()
                if peer is not None:
                    peer["relay"][n] = body
                    room["relay_bytes"] += size
                    STATS["relay_bytes"] += size
                    STATS["day_bytes"] = STATS.get("day_bytes", 0) + size
                    LOCK.notify_all()
            h.send_json(200, {"ok": True})
            return True
        if method == "GET":
            token = (q.get("token") or [""])[0]
            epoch = int((q.get("e") or ["0"])[0] or 0) if (q.get("e") or ["0"])[0].isdigit() else -1
            deadline = _now() + POLL_WAIT
            with LOCK:
                if _who(room, token) != pid:
                    h.error(403, "Not allowed.")
                    return True
                while True:
                    peer = room["peers"].get(pid)
                    if _dead(room, _now()):
                        room["closed"] = True
                    if room["closed"] or rid not in ROOMS or peer is None:
                        h.send_json(404, {"error": "The sender isn't sharing this any more.", "code": "gone"})
                        return True
                    if peer["epoch"] != epoch:            # the sender's page reloaded: pieces restart from 0
                        h.send_json(409, {"error": "restart", "code": "epoch"})
                        return True
                    peer["seen"] = _now()
                    old = [k for k in peer["relay"] if k < n]   # asking for n means everything before n arrived
                    for k in old:
                        del peer["relay"][k]
                    if old:
                        LOCK.notify_all()                        # room in the window for the sender
                    if n in peer["relay"]:
                        body = peer["relay"][n]                  # kept until n+1 is asked for, so a dropped read can retry
                        break
                    if _now() >= deadline:
                        h.send_response(204)
                        h.send_header("Cache-Control", "no-store")
                        h.send_header("Content-Length", "0")
                        h.end_headers()
                        return True
                    LOCK.wait(min(5, deadline - _now()))
            h.send_response(200)
            h.send_header("Content-Type", "application/octet-stream")
            h.send_header("Cache-Control", "no-store")
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)
            return True
    h.error(404, "not found")
    return True
