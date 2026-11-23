#!/usr/bin/env node
// WebShare – local / offline server (zero dependencies).
//
// Serves the same app as https://umilan.github.io/webshare/ (docs/index.html) on your network and
// replaces the PeerJS cloud with a built-in PeerJS-compatible signaling server, so no internet is needed:
//   share:  http://localhost:8080/  (on this computer)   or  https://<ip>:8443/  (phones – camera needs HTTPS)
//   watch:  http://<ip>:8080/?watch=CODE   (what the Share link / QR point to)
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ROOT = path.join(__dirname, 'docs');
const CERT_DIR = path.join(__dirname, 'certs');

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ------------------------------------------------------------------ static files (+ config injection)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    if (path.basename(file) === 'index.html') {
      // tell the page it runs on the local server: use this server for signaling and IP-based links
      const cfg = { httpPort: HTTP_PORT, httpsPort: httpsServer ? HTTPS_PORT : null, ips: lanIPs() };
      data = Buffer.from(data.toString().replace('</head>', `<script>window.WEBSHARE_LOCAL=${JSON.stringify(cfg)}</script>\n</head>`));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function app(req, res) {
  const u = new URL(req.url, 'http://x');
  // PeerJS REST: random id for peers that don't choose their own
  if (req.method === 'GET' && u.pathname === '/peerjs/id') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(crypto.randomUUID());
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, u);
  res.writeHead(405); res.end();
}

// ------------------------------------------------------------------ minimal WebSocket (RFC 6455)
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  return true;
}
function wsSend(socket, text) {
  if (socket.destroyed) return;
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n])
    : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  socket.write(Buffer.concat([head, payload]));
}
function wsReader(socket, onText, onClose) {
  let buf = Buffer.alloc(0), frags = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return socket.destroy(); // signaling messages are tiny
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(Buffer.from([0x88, 0])); return onClose(); }       // close
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; } // ping -> pong
      if (op === 0x1 || op === 0x0) {
        frags.push(data);
        if (fin) { const text = Buffer.concat(frags).toString(); frags = []; onText(text); }
      }
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => socket.destroy());
}

// ------------------------------------------------------------------ PeerJS-compatible signaling
// Protocol (as spoken by the PeerJS client): server sends OPEN / ID-TAKEN / EXPIRE;
// clients send HEARTBEAT and OFFER / ANSWER / CANDIDATE / LEAVE with a `dst`, which we relay with `src`.
const clients = new Map(); // id -> { socket, token }

function onUpgrade(req, socket) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/peerjs') return socket.destroy();
  const id = (u.searchParams.get('id') || '').slice(0, 64), token = u.searchParams.get('token') || '';
  if (!id || !wsAccept(req, socket)) return;

  const existing = clients.get(id);
  if (existing && existing.token !== token) {
    wsSend(socket, JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } }));
    return socket.end();
  }
  if (existing) existing.socket.destroy(); // same peer reconnecting
  const me = { socket, token };
  clients.set(id, me);
  wsSend(socket, JSON.stringify({ type: 'OPEN' }));

  wsReader(socket, (text) => {
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || msg.type === 'HEARTBEAT' || !msg.dst) return;
    const dst = clients.get(msg.dst);
    if (dst) wsSend(dst.socket, JSON.stringify({ type: msg.type, src: id, dst: msg.dst, payload: msg.payload }));
    else if (msg.type !== 'LEAVE' && msg.type !== 'EXPIRE') {
      wsSend(socket, JSON.stringify({ type: 'EXPIRE', src: msg.dst, dst: id })); // -> "peer-unavailable" on the client
    }
  }, () => { if (clients.get(id) === me) clients.delete(id); });
}

// ------------------------------------------------------------------ servers
function loadOrCreateCert() {
  const key = path.join(CERT_DIR, 'key.pem'), cert = path.join(CERT_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    try {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map((ip) => `IP:${ip}`)].join(',');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-keyout', key, '-out', cert, '-subj', '/CN=webshare', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    } catch (e) { return null; }
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const httpServer = http.createServer(app);
httpServer.on('upgrade', onUpgrade);
httpServer.listen(HTTP_PORT, '0.0.0.0');

let httpsServer = null;
const creds = process.env.NO_HTTPS ? null : loadOrCreateCert();
if (creds) {
  httpsServer = https.createServer(creds, app);
  httpsServer.on('upgrade', onUpgrade);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
}

httpServer.on('listening', () => {
  const ips = lanIPs(), line = '─'.repeat(64);
  console.log(`\n${line}\n  WebShare – local server (works without internet)\n${line}`);
  console.log(`\n  Share from this computer:   http://localhost:${HTTP_PORT}/`);
  if (httpsServer) for (const ip of ips) console.log(`  Share from a phone:         https://${ip}:${HTTPS_PORT}/   (accept the certificate warning once)`);
  console.log(`\n  Watch (any browser on this network):`);
  for (const ip of ips) console.log(`     http://${ip}:${HTTP_PORT}/?watch=CODE`);
  console.log(`\n  The Share button in the app shows the exact link and QR code.\n${line}\n`);
});
