#!/usr/bin/env python3
"""Scaredy GmCat (scaredy.gmcat.io): send a file without leaving it on anyone's server. Claude, 2026-11-19.

Python standard library only. Listens on 127.0.0.1; Nginx serves the static site and passes /api/ here.
Nothing is written to disk: rooms (rooms.py) live in memory. No IP addresses are stored: rate limits use a salted
hash that only lives in memory and changes every time the service starts.

Environment:
  SCAREDY_PORT          default 4186
  SCAREDY_DEV_STATIC    a folder to serve for local tests (the built site), so one process serves site + API
  SCAREDY_ORIGINS       comma-separated origins allowed to POST (default https://scaredy.gmcat.io)
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rooms  # noqa: E402

PORT = int(os.environ.get("SCAREDY_PORT", "4186"))
DEV_STATIC = os.environ.get("SCAREDY_DEV_STATIC", "")
ORIGINS = {o.strip() for o in os.environ.get("SCAREDY_ORIGINS", "https://scaredy.gmcat.io").split(",") if o.strip()}
SALT = secrets.token_bytes(32)          # in memory only
HITS, HITS_LOCK = {}, threading.Lock()  # visitor -> recent POST times (rate limit)
POSTS_PER_MINUTE = 240                  # signalling + relay pieces are many small requests; this only stops floods
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
         ".webmanifest": "application/manifest+json", ".json": "application/json", ".xml": "application/xml"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ScaredyGmCat"
    sys_version = ""

    def log_message(self, *args):   # no access log (privacy)
        pass

    def handle_one_request(self):
        # a browser that closed while we were answering (long polls, closed tabs) isn't an error worth logging
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # ---- helpers used by rooms.py ----
    def visitor(self):
        ip = self.headers.get("X-Real-IP") or self.client_address[0]
        return hmac.new(SALT, ip.encode(), "sha256").hexdigest()[:16]

    def read_json(self, limit=4096):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def drain(self):
        n = int(self.headers.get("Content-Length") or 0)
        while n > 0:
            chunk = self.rfile.read(min(n, 65536))
            if not chunk:
                break
            n -= len(chunk)

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, code, msg):
        self.send_json(code, {"error": msg})

    # ---- routing ----
    def parts(self):
        path = urllib.parse.urlsplit(self.path).path
        return [p for p in path.split("/") if p]

    def too_many(self):
        v, t = self.visitor(), time.time()
        with HITS_LOCK:
            recent = [x for x in HITS.get(v, []) if x > t - 60]
            recent.append(t)
            HITS[v] = recent
            if len(HITS) > 20000:
                for k in [k for k, xs in HITS.items() if not xs or xs[-1] < t - 60]:
                    del HITS[k]
        return len(recent) > POSTS_PER_MINUTE

    def do_GET(self):
        parts = self.parts()
        if parts == ["api", "health"]:
            return self.send_json(200, {"ok": True, "rooms": len(rooms.ROOMS)})
        if parts[:1] == ["api"]:
            if rooms.handle(self, "GET", parts):
                return
            return self.error(404, "not found")
        if DEV_STATIC:
            return self.static(parts)
        self.error(404, "not found")

    def do_POST(self):
        parts = self.parts()
        origin = self.headers.get("Origin")
        if origin and origin not in ORIGINS:
            self.drain()
            return self.error(403, "Not allowed from that site.")
        if self.too_many():
            self.drain()
            return self.error(429, "Too many requests. Please slow down.")
        if parts[:1] == ["api"] and rooms.handle(self, "POST", parts):
            return
        self.drain()
        self.error(404, "not found")

    def static(self, parts):
        if len(parts) == 1 and re.match(r"^[2-9a-hjkmnp-z]{4}-?[2-9a-hjkmnp-z]{4}$", parts[0]):
            parts = []                       # a short link: the same page (Nginx does this live)
        root = Path(DEV_STATIC).resolve()
        f = (root / "/".join(parts)).resolve()
        if root not in f.parents and f != root:
            return self.error(404, "not found")
        if f.is_dir():
            f = f / "index.html"
        if not f.is_file():
            return self.error(404, "not found")
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(f.suffix, "application/octet-stream"))
        # same rules as the live Nginx config, so local tests catch anything they would block
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob: https://home.gmcat.io; media-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print("Scaredy GmCat on 127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
