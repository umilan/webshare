# WebShare

Share your **camera, screen, a photo/video or your own text** from a browser and watch it in any
other browser – no app needed.

Two ways to run the same app:

| | Online – GitHub Pages | Offline – your own network |
| --- | --- | --- |
| Open | https://umilan.github.io/webshare/ | `node server.js` on a computer |
| Watch link | `https://umilan.github.io/webshare/?watch=CODE` | `http://<computer IP>:8080/?watch=CODE` |
| Internet needed | yes (free PeerJS service connects the browsers) | **no** – the server connects them |
| Viewers | anywhere | same Wi-Fi / LAN (or VPN like Tailscale) |

Video always goes directly between the browsers (WebRTC).

## Offline / IP mode

```bash
node server.js            # Node 16+, no npm install needed
```

The console prints the addresses:

```
Share from this computer:   http://localhost:8080/
Share from a phone:         https://192.168.1.20:8443/   (accept the certificate warning once)
Watch (any browser on this network):
   http://192.168.1.20:8080/?watch=CODE
```

* Press **Transmit**, then **Share** – the link and QR code use the computer's IP address.
* Phones need a secure page for the camera, so opening `http://<ip>:8080/` on a phone automatically
  switches to `https://<ip>:8443/` (self-signed certificate, generated with `openssl` into `certs/`).
  Watching works over plain `http://`.
* `server.js` serves `docs/` and contains a small PeerJS-compatible signaling server (WebSocket),
  so there are no dependencies and no external requests. The JS libraries are bundled in `docs/vendor/`.
* Ports: `PORT=8080`, `HTTPS_PORT=8443`, `NO_HTTPS=1` disables HTTPS. Allow these in your firewall.
* No authentication – anyone on your network with the code can watch.

## Files

* `docs/index.html` – the whole app (sharer + viewer), also published to GitHub Pages.
* `docs/vendor/` – PeerJS 1.5.4, qrcodejs 1.0.0, jsQR 1.4.0 (MIT).
* `server.js` – offline server for your own network.
