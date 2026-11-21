# WebShare

Share your **camera** or **screen** from a web browser and watch it on any other device on the
network by simply opening `http://<ip>:8080` in a browser. No app to install for viewers,
no npm dependencies for the server.

## Run

```bash
node server.js        # or: npm start
```

The console prints every address, e.g.:

```
SHARE (on this computer):   http://localhost:8080/share
SHARE (from other device):  https://192.168.1.20:8443/share
WATCH (any browser, no app): http://192.168.1.20:8080/
Plain MJPEG stream:          http://192.168.1.20:8080/stream.mjpg
```

1. On the computer running the server open **http://localhost:8080/share**, pick *Screen* or
   *Camera*, press **Start sharing**.
2. On any phone / tablet / TV / PC open **http://&lt;ip&gt;:8080/** — the picture appears.

## How it works

| URL | What it is |
| --- | --- |
| `/share` | Sharer page (screen, window, tab or camera, optional audio, 480p–1080p) |
| `/` | Viewer page – WebRTC (low latency, audio); falls back to MJPEG automatically after 10 s |
| `/?mode=mjpeg` | Viewer forced to MJPEG |
| `/stream.mjpg` | Raw MJPEG stream – works in VLC, smart‑TV browsers, `<img src>` tags, OBS browser source |
| `/snapshot.jpg` | Last MJPEG frame (only refreshed while an MJPEG viewer is connected) |
| `?room=name` | Add to any URL to run several independent shares at once |

* Signaling uses Server‑Sent Events + POST, so the server is plain Node.js with zero dependencies.
* Video goes peer‑to‑peer (WebRTC) from the sharing browser to each viewer; the MJPEG fallback
  is relayed through the server at ~10 fps and is only encoded while someone watches it.

## Notes

* Browsers only allow camera/screen capture on **secure pages**: `http://localhost` is fine on the
  server machine. To share a phone's camera, open `https://<ip>:8443/share` and accept the
  self‑signed certificate warning (generated automatically into `certs/` with `openssl`).
* Mobile browsers generally can't share their screen — use *Camera* there.
* Viewers start muted (autoplay rules); tap **Unmute** if audio was shared.
* Ports: `PORT=8080`, `HTTPS_PORT=8443`, set `NO_HTTPS=1` to disable HTTPS. Allow these ports in
  your firewall if other devices can't connect.
* No authentication – anyone on your network who knows the address can watch. Use on trusted networks.

## GitHub Pages version (no server)

`docs/index.html` is a single-file version hosted at **https://umilan.github.io/webshare/**.
GitHub Pages can't run `server.js`, so it uses the free PeerJS cloud service to connect the browsers
(video still goes directly between them). Press **Start sharing**, then open the shown link,
scan the QR code, or type the 6-letter code on another device. Because github.io is HTTPS,
phones can share their camera too. There is no IP address or MJPEG stream in this version.
