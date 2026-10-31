'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CHANNELS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];

const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH  = path.join(__dirname, 'key.pem');

let httpServer, io, scheme;

const app = express();

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|html|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  httpServer = https.createServer(
    { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) },
    app
  );
  scheme = 'https';

  // Also run a tiny HTTP listener on :3001 that redirects to HTTPS :3000.
  // (3000 is already taken by the HTTPS server, so we use 3001 for the redirect.)
  const redirectServer = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0] || 'localhost';
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  });
  redirectServer.listen(3001, '0.0.0.0', () => {
    console.log(`HTTP redirect listening on http://0.0.0.0:3001 -> https://*:${PORT}`);
  });
} else {
  httpServer = http.createServer(app);
  scheme = 'http';
  console.log('WARNING: no cert.pem / key.pem found — serving over HTTP.');
  console.log('         Phones on LAN will NOT be able to access the microphone.');
  console.log('         Generate certs with mkcert (see README / step 6) to enable HTTPS.');
}

io = new Server(httpServer, { maxHttpBufferSize: 4 * 1024 * 1024 });

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
const devices = Object.create(null);
const channels = Object.create(null);
for (const name of CHANNELS) channels[name] = { busyBy: null, lastSender: null, lastSendAt: 0 };

function shortId() {
  for (let i = 0; i < 32; i++) {
    const id = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    if (!devices[id]) return id;
  }
  return Math.random().toString(16).slice(2, 10);
}
function clientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : (socket.handshake.address || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || 'unknown';
}
function publicDeviceList() {
  return Object.entries(devices).map(([id, d]) => ({
    id, channel: d.channel || null, ip: d.ip, isTransmitting: !!d.isTransmitting,
  }));
}
function broadcastDevices() { io.emit('devices:update', publicDeviceList()); }

function tryReleaseTransmission(deviceId) {
  const d = devices[deviceId];
  if (!d || !d.isTransmitting) return;
  const ch = d.channel;
  d.isTransmitting = false;
  if (ch && channels[ch] && channels[ch].busyBy === deviceId) {
    channels[ch].busyBy = null;
    channels[ch].lastSender = deviceId;
    channels[ch].lastSendAt = Date.now();
    io.to(ch).emit('channel:free');
  }
  broadcastDevices();
}

io.on('connection', (socket) => {
  const id = shortId();
  devices[id] = { socketId: socket.id, channel: null, ip: clientIp(socket), isTransmitting: false };
  socket.data.deviceId = id;

  socket.emit('joined', { deviceId: id });
  broadcastDevices();

  socket.on('join', (payload = {}) => {
    const { channel } = payload;
    if (!CHANNELS.includes(channel)) { socket.emit('error', { message: `Unknown channel: ${channel}` }); return; }
    const d = devices[id]; if (!d) return;
    if (d.channel && d.channel !== channel) { tryReleaseTransmission(id); socket.leave(d.channel); }
    d.channel = channel;
    socket.join(channel);
    socket.emit('joined', { deviceId: id, channel });
    const ch = channels[channel];
    if (ch && ch.busyBy) socket.emit('channel:busy', { byDeviceId: ch.busyBy });
    else socket.emit('channel:free');
    broadcastDevices();
  });

  socket.on('leave', () => {
    const d = devices[id]; if (!d) return;
    tryReleaseTransmission(id);
    if (d.channel) { socket.leave(d.channel); d.channel = null; }
    broadcastDevices();
  });

  socket.on('ptt:start', () => {
    const d = devices[id];
    if (!d || !d.channel) { socket.emit('error', { message: 'Not in a channel' }); return; }
    const ch = channels[d.channel];
    if (!ch) { socket.emit('error', { message: 'Channel missing' }); return; }
    if (ch.busyBy && ch.busyBy !== id) {
      socket.emit('error', { message: 'Channel busy' });
      socket.emit('channel:busy', { byDeviceId: ch.busyBy });
      return;
    }
    if (d.isTransmitting) return;
    ch.busyBy = id;
    d.isTransmitting = true;
    ch.lastSender = id;
    ch.lastSendAt = Date.now();
    socket.to(d.channel).emit('channel:busy', { byDeviceId: id });
    broadcastDevices();
  });

  socket.on('ptt:stop', () => { tryReleaseTransmission(id); });

  socket.on('audio', (payload = {}) => {
    const d = devices[id];
    if (!d || !d.channel) return;
    const ch = channels[d.channel];
    if (!ch) return;
    const isCurrent = ch.busyBy === id;
    const isRecentRelease = ch.lastSender === id && (Date.now() - ch.lastSendAt) < 5000;
    if (!isCurrent && !isRecentRelease) {
      console.warn(`audio rejected: id=${id} busyBy=${ch.busyBy} lastSender=${ch.lastSender}`);
      return;
    }
    if (!payload || !payload.data) return;
    socket.to(d.channel).emit('audio', {
      fromDeviceId: id,
      mimeType: payload.mimeType || 'audio/webm',
      data: payload.data,
    });
    console.log(`audio relayed: from=${id} channel=${d.channel} bytes=${payload.data.byteLength || payload.data.length || '?'}`);
  });

  socket.on('disconnect', () => {
    tryReleaseTransmission(id);
    delete devices[id];
    broadcastDevices();
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`PTT server listening on ${scheme}://0.0.0.0:${PORT}`);
  if (scheme === 'https') {
    console.log('Microphone access enabled on phones (HTTPS).');
    console.log(`Open https://<your-lan-ip>:${PORT} on phones after trusting the cert.`);
  }
});