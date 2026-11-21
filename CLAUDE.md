# WebShare – working rules

- **Always publish + merge after every change.** Commit, then run `./publish.sh`, which:
  1. pushes the current branch,
  2. merges it into `main` (fast-forward push),
  3. copies `docs/` to the `gh-pages` branch → live at https://umilan.github.io/webshare/.
  Then verify the live page shows the change (cache-bust with `?x=random`).
- Work on `main` directly when the session allows it; otherwise use the session branch and let
  `publish.sh` merge it into `main`. Pushes to `main` that touch `docs/` also auto-publish via
  `.github/workflows/pages.yml`.
- `docs/index.html` = single-file GitHub Pages app (PeerJS signaling).
  `server.js` + `public/` = local LAN server version (http://<ip>:8080, MJPEG).
- Test with Playwright before publishing (fake camera: `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream`; pass the HTTPS proxy so PeerJS is reachable).
