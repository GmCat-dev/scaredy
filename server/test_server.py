#!/usr/bin/env python3
"""Tests for the Scaredy GmCat service (standard library only). Run: python3 test_server.py
Starts the service on a spare local port and checks what the page promises: rooms live in memory only, a relay piece
is handed over once and then forgotten, a short link hands its key to people who join, a refresh (close "soon", then
resume) keeps the link, and a stop closes it at once. Claude, 2026-11-20."""
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.py") if os.path.exists(os.path.join(HERE, "server.py")) else os.path.join(HERE, "..", "server", "server.py")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Scaredy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port(); cls.base = "http://127.0.0.1:%d" % cls.port
        env = dict(os.environ, SCAREDY_PORT=str(cls.port), SCAREDY_ORIGINS=cls.base)
        cls.proc = subprocess.Popen([sys.executable, SERVER], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(cls.base + "/api/health", timeout=1); break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate(); cls.proc.wait(5)

    def call(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"Content-Type": "application/json", "Origin": self.base}; h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read(); ct = r.headers.get("Content-Type", "")
                return r.status, (json.loads(b) if "json" in ct and b else b)
        except urllib.error.HTTPError as e:
            b = e.read()
            try:
                return e.code, json.loads(b)
            except ValueError:
                return e.code, b

    def room(self, mode="direct", **extra):
        st, d = self.call("POST", "/api/rooms", dict(mode=mode, **extra)); self.assertEqual(st, 201); return d

    def test_signalling_between_two_pages(self):
        r = self.room()
        st, j = self.call("POST", "/api/%s/join" % r["room"], {}); self.assertEqual(st, 200)
        st, d = self.call("GET", "/api/%s/poll?token=%s" % (r["room"], r["token"]))
        self.assertEqual(d["msgs"][0], {"type": "join", "peer": j["peer"]})
        self.call("POST", "/api/%s/send" % r["room"], {"token": r["token"], "to": j["peer"], "data": {"type": "offer"}})
        st, d = self.call("GET", "/api/%s/poll?token=%s" % (r["room"], j["token"]))
        self.assertEqual(d["msgs"][0]["data"], {"type": "offer"})
        st, _ = self.call("POST", "/api/%s/send" % r["room"], {"token": "wrong", "to": "sender", "data": {}}); self.assertEqual(st, 403)

    def test_relay_piece_is_handed_over_once(self):
        r = self.room("relay"); _, j = self.call("POST", "/api/%s/join" % r["room"], {})
        path = "/api/%s/relay/%s/0" % (r["room"], j["peer"])
        st, _ = self.call("POST", path, raw=b"locked-bytes", headers={"X-Scaredy-Token": r["token"], "Content-Type": "application/octet-stream"})
        self.assertEqual(st, 200)
        st, body = self.call("GET", path + "?token=" + j["token"]); self.assertEqual((st, body), (200, b"locked-bytes"))
        # gone after one hand-over: asking again just waits (204 after the long poll)
        t = time.time(); st, _ = self.call("GET", path + "?token=" + j["token"]); self.assertEqual(st, 204); self.assertGreater(time.time() - t, 15)

    def test_short_link_hands_over_its_key(self):
        r = self.room("short", key="A" * 22); st, j = self.call("POST", "/api/%s/join" % r["room"], {})
        self.assertEqual((st, j["key"], j["mode"]), (200, "A" * 22, "short"))
        st, _ = self.call("POST", "/api/rooms", {"mode": "short", "key": "bad key!"}); self.assertEqual(st, 400)

    def test_refresh_keeps_the_link_and_stop_ends_it(self):
        r = self.room(); _, j = self.call("POST", "/api/%s/join" % r["room"], {})
        self.call("POST", "/api/%s/close" % r["room"], {"token": r["token"], "soon": True})        # page unloading
        st, d = self.call("POST", "/api/%s/resume" % r["room"], {"token": r["token"]}); self.assertEqual(st, 200)
        st, d = self.call("GET", "/api/%s/poll?token=%s" % (r["room"], j["token"]))
        self.assertEqual(d["msgs"][0]["data"]["type"], "again")                                   # receiver reconnects
        self.call("POST", "/api/%s/close" % r["room"], {"token": r["token"]})                      # Stop sharing
        st, d = self.call("POST", "/api/%s/join" % r["room"], {}); self.assertEqual((st, d.get("code")), (404, "gone"))

    def test_direct_falls_back_to_relay_for_one_person(self):
        r = self.room("direct", fallback=True)
        _, j = self.call("POST", "/api/%s/join" % r["room"], {}); self.assertTrue(j["fallback"])
        _, k = self.call("POST", "/api/%s/join" % r["room"], {})
        hdr = {"X-Scaredy-Token": r["token"], "Content-Type": "application/octet-stream"}
        path = "/api/%s/relay/%s/0" % (r["room"], j["peer"])
        st, _ = self.call("POST", path, raw=b"x", headers=hdr); self.assertEqual(st, 400)            # not switched yet
        st, _ = self.call("POST", "/api/%s/send" % r["room"], {"token": j["token"], "to": j["peer"], "data": {"type": "relay"}})
        self.assertEqual(st, 403)                                                                    # only the sender switches
        st, _ = self.call("POST", "/api/%s/send" % r["room"], {"token": r["token"], "to": j["peer"], "data": {"type": "relay"}})
        self.assertEqual(st, 200)
        st, d = self.call("GET", "/api/%s/poll?token=%s" % (r["room"], j["token"])); self.assertEqual(d["msgs"][0]["data"], {"type": "relay"})
        st, _ = self.call("POST", path, raw=b"locked", headers=hdr); self.assertEqual(st, 200)
        st, body = self.call("GET", path + "?token=" + j["token"]); self.assertEqual((st, body), (200, b"locked"))
        st, _ = self.call("POST", "/api/%s/relay/%s/0" % (r["room"], k["peer"]), raw=b"x", headers=hdr); self.assertEqual(st, 400)  # others stay direct
        # a refresh remembers who uses the relay
        self.call("POST", "/api/%s/close" % r["room"], {"token": r["token"], "soon": True})
        self.call("POST", "/api/%s/resume" % r["room"], {"token": r["token"]})
        st, d = self.call("GET", "/api/%s/poll?token=%s" % (r["room"], r["token"]))
        self.assertEqual({m["peer"]: m["via"] for m in d["msgs"]}, {j["peer"]: "relay", k["peer"]: ""})

    def test_other_sites_cannot_post(self):
        st, _ = self.call("POST", "/api/rooms", {"mode": "direct"}, headers={"Origin": "https://evil.example"}); self.assertEqual(st, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
