#!/usr/bin/env node
// WebShare - zero-dependency camera / screen sharing server.
// Share from one browser, watch from any other browser on the network via http://<ip>:<port>
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
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

// ---------------------------------------------------------------- rooms
// room = { broadcaster: client|null, viewers: Map<id, client>, mjpeg: Set<res>, lastFrame: Buffer|null }
const rooms = new Map();
function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { broadcaster: null, viewers: new Map(), mjpeg: new Set(), lastFrame: null });
  return rooms.get(name);
}
const roomName = (u) => (u.searchParams.get('room') || 'main').replace(/[^\w-]/g, '').slice(0, 40) || 'main';

function send(client, msg) {
  if (client && !client.res.writableEnded) client.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function notifyStats(room) {
  send(room.broadcaster, { type: 'stats', viewers: [...room.viewers.values()].filter((v) => v.rtc).length, mjpeg: room.mjpeg.size });
}

// ---------------------------------------------------------------- handlers
function handleEvents(req, res, u) {
  const room = getRoom(roomName(u));
  const role = u.searchParams.get('role') === 'broadcaster' ? 'broadcaster' : 'viewer';
  const id = crypto.randomBytes(8).toString('hex');
  const rtc = u.searchParams.get('rtc') !== '0';
  const client = { id, role, res, rtc };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  if (role === 'broadcaster') {
    if (room.broadcaster) { send(room.broadcaster, { type: 'replaced' }); room.broadcaster.res.end(); }
    room.broadcaster = client;
    send(client, { type: 'hello', id });
    for (const v of room.viewers.values()) {
      if (v.rtc) send(client, { type: 'viewer-join', from: v.id });
      send(v, { type: 'broadcaster-ready' });
    }
    notifyStats(room);
  } else {
    room.viewers.set(id, client);
    send(client, { type: 'hello', id, live: !!room.broadcaster });
    if (rtc) send(room.broadcaster, { type: 'viewer-join', from: id });
    notifyStats(room);
  }

  req.on('close', () => {
    clearInterval(ping);
    if (role === 'broadcaster') {
      if (room.broadcaster === client) {
        room.broadcaster = null;
        room.lastFrame = null;
        for (const v of room.viewers.values()) send(v, { type: 'broadcaster-left' });
      }
    } else {
      room.viewers.delete(id);
      if (rtc) send(room.broadcaster, { type: 'viewer-leave', from: id });
      notifyStats(room);
    }
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleSignal(req, res, u) {
  try {
    const msg = JSON.parse((await readBody(req, 256 * 1024)).toString());
    const room = getRoom(roomName(u));
    const all = [room.broadcaster, ...room.viewers.values()].filter(Boolean);
    const from = all.find((c) => c.id === msg.from);
    const to = all.find((c) => c.id === msg.to);
    if (!from || !to || from.role === to.role) { res.writeHead(404); return res.end(); }
    send(to, { type: 'signal', from: from.id, data: msg.data });
    res.writeHead(204); res.end();
  } catch (e) { res.writeHead(400); res.end(); }
}

async function handleFrame(req, res, u) {
  const room = getRoom(roomName(u));
  if (!room.broadcaster || u.searchParams.get('id') !== room.broadcaster.id) { res.writeHead(403); return res.end(); }
  try {
    const jpg = await readBody(req, 8 * 1024 * 1024);
    room.lastFrame = jpg;
    for (const r of room.mjpeg) {
      r.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`);
      r.write(jpg); r.write('\r\n');
    }
    res.writeHead(204); res.end();
  } catch (e) { res.writeHead(413); res.end(); }
}

function handleMjpeg(req, res, u) {
  const room = getRoom(roomName(u));
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache', Connection: 'close',
  });
  room.mjpeg.add(res);
  if (room.lastFrame) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${room.lastFrame.length}\r\n\r\n`);
    res.write(room.lastFrame); res.write('\r\n');
  }
  notifyStats(room);
  req.on('close', () => { room.mjpeg.delete(res); notifyStats(room); });
}

function handleSnapshot(req, res, u) {
  const room = getRoom(roomName(u));
  if (!room.lastFrame) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No frame yet'); }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  res.end(room.lastFrame);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/view.html';
  else if (p === '/share') p = '/share.html';
  else if (p === '/view' || p === '/watch') p = '/view.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function handleInfo(req, res, u) {
  const room = getRoom(roomName(u));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    httpPort: HTTP_PORT, httpsPort: httpsServer ? HTTPS_PORT : null,
    ips: lanIPs(), live: !!room.broadcaster, viewers: [...room.viewers.values()].filter((v) => v.rtc).length, mjpeg: room.mjpeg.size,
  }));
}

function app(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/events') return handleEvents(req, res, u);
  if (req.method === 'POST' && u.pathname === '/signal') return handleSignal(req, res, u);
  if (req.method === 'POST' && u.pathname === '/frame') return handleFrame(req, res, u);
  if (req.method === 'GET' && (u.pathname === '/stream.mjpg' || u.pathname === '/mjpeg')) return handleMjpeg(req, res, u);
  if (req.method === 'GET' && u.pathname === '/snapshot.jpg') return handleSnapshot(req, res, u);
  if (req.method === 'GET' && u.pathname === '/info') return handleInfo(req, res, u);
  if (req.method === 'GET') return serveStatic(req, res, u);
  res.writeHead(405); res.end();
}

// ---------------------------------------------------------------- startup
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function loadOrCreateCert() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
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
httpServer.listen(HTTP_PORT, '0.0.0.0');

let httpsServer = null;
const creds = process.env.NO_HTTPS ? null : loadOrCreateCert();
if (creds) {
  httpsServer = https.createServer(creds, app);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
}

httpServer.on('listening', () => {
  const ips = lanIPs();
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  WebShare is running\n${line}`);
  console.log(`\n  SHARE (on this computer):   http://localhost:${HTTP_PORT}/share`);
  if (httpsServer) for (const ip of ips) console.log(`  SHARE (from other device):  https://${ip}:${HTTPS_PORT}/share`);
  console.log(`\n  WATCH (any browser, no app):`);
  for (const ip of ips) console.log(`     http://${ip}:${HTTP_PORT}/`);
  console.log(`\n  Plain MJPEG stream (VLC, smart TVs, <img> tags):`);
  for (const ip of ips) console.log(`     http://${ip}:${HTTP_PORT}/stream.mjpg`);
  console.log(`\n${line}\n`);
});
