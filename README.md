# Scaredy GmCat 👻

The code behind **[Scaredy GmCat](https://scaredy.gmcat.io)**, a free tool from [GmCat](https://gmcat.io) that sends
files **without leaving them on anyone's server**. No account, no ads, no tracking cookies.

Your files stay on your device. The other person gets them from your open page, one of three ways:

- **Direct**: browser to browser over WebRTC. Our server only helps the two browsers find each other.
- **Encrypted relay**: for networks that block direct connections. Locked pieces pass through our server, which hands
  each one over once and forgets it. Nothing is written to disk.
- **Short link** (`scaredy.gmcat.io/k7m2-x9pq`): like Direct, but easy to type or say. The link has no room for the key,
  so the server holds it in memory while you share and hands it to the people who join.

Files are encrypted in the browser with AES-GCM (Web Crypto). With Direct and Encrypted relay the key lives in the link
after `#`, which browsers never send to a server, so the relay only ever sees scrambled pieces.

This repository is published so anyone can check that Scaredy does what its page says.

## Where to look

| What | File |
|---|---|
| Encryption (seal / unseal, the key in the link) | [`site/scaredy.js`](site/scaredy.js): `seal`, `unseal`, `importKey` |
| Sending, receiving, the three modes | `site/scaredy.js`: `sender()`, `receiver()` |
| Refresh safety (the copy kept in your own browser) | `site/scaredy.js`: `Keep` (IndexedDB, wiped on Stop sharing) |
| Big files straight to the downloads folder (nothing piles up in memory) | `site/scaredy.js`: `Pipe` + [`site/sw.js`](site/sw.js) (a service worker that passes pieces through once, stores nothing) |
| Carrying on after a dropped connection | `site/scaredy.js`: `lost()` (sender reconnects), `T_DATA2` pieces carry their place in the file, `resetPartial()` (receiver keeps what arrived) |
| The service: signalling + relay, memory only | [`server/rooms.py`](server/rooms.py) (the API is listed at the top), `server/server.py` |
| Limits (fair use, rate limits) | top of `server/rooms.py` and `server/server.py` |
| Tests | `python3 server/test_server.py` |
| Example Nginx + systemd setup | `server/nginx-example.conf`, `server/gmcat-scaredy.service` |
| Page analytics (cookieless page counts, honours Do Not Track) | `site/insights.js` |

## Run it yourself

```sh
python3 build.py
SCAREDY_PORT=4386 SCAREDY_DEV_STATIC=$PWD/dist SCAREDY_ORIGINS=http://127.0.0.1:4386 python3 server/server.py
# open http://127.0.0.1:4386
```

Python 3 standard library only; nothing to install.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Code: [GNU AGPL-3.0](LICENSE). You can use, change and share it, including running it as a service, as long as you
share your changes under the same licence with the people who use your service.
Want to use it without those terms (closed source)? See the [commercial licence](COMMERCIAL.md), paid in $GMGM.
Third-party code is listed in [NOTICE.md](NOTICE.md).
The GmCat name, character and artwork (including the pictures in `site/img/`) are not covered by either licence; all
rights reserved.
