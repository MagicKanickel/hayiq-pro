// ============================================================================
//  Heubedampfer-Relay  ·  Geraet <-> Server <-> Browser
//  - /device  : WebSocket fuer den ESP32 (Auth per Geraete-Token)
//  - /app     : WebSocket fuer eingeloggte Browser (Auth per Session-Cookie)
//  - HTTP     : Login, statische Web-App, Status-Abruf
//  TLS/Domain uebernimmt Coolify (Reverse-Proxy davor) -> hier nur HTTP/WS.
// ============================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Konfiguration (in Coolify als Environment-Variablen setzen) ─────────────
const PORT           = parseInt(process.env.PORT || '3000', 10);
const DEVICE_TOKEN   = process.env.DEVICE_TOKEN   || '';          // Pflicht!
const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS     = process.env.ADMIN_PASS     || '';          // Pflicht!
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TARGET_MIN     = parseFloat(process.env.TARGET_MIN || '0');
const TARGET_MAX     = parseFloat(process.env.TARGET_MAX || '99');

if (!DEVICE_TOKEN || !ADMIN_PASS) {
  console.error('[FATAL] DEVICE_TOKEN und ADMIN_PASS muessen gesetzt sein (Environment).');
  process.exit(1);
}

// Konstanter Zeitvergleich gegen Timing-Angriffe.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Laufzeit-Zustand ────────────────────────────────────────────────────────
let deviceSocket = null;                 // aktuelle Geraeteverbindung (genau eine)
let deviceOnline = false;
let lastStatus   = null;                 // letzter Status vom Geraet
let lastSeen     = 0;                    // millis des letzten Statuspakets
const appClients = new Set();            // eingeloggte Browser-Sockets

const VALID_ACTIONS = new Set(['start', 'stop', 'pause', 'resume', 'setTarget']);

// ── HTTP / Express ──────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);               // hinter dem Coolify-Reverse-Proxy
app.use(express.json({ limit: '8kb' }));

const sessionParser = session({
  name: 'hbd.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',                      // Cookie nur ueber HTTPS (Coolify terminiert TLS)
    maxAge: 1000 * 60 * 60 * 24 * 30     // 30 Tage
  }
});
app.use(sessionParser);

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.status(401).json({ error: 'nicht angemeldet' });
}

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  const ok = safeEqual(user || '', ADMIN_USER) & safeEqual(pass || '', ADMIN_PASS);
  if (!ok) return res.status(401).json({ error: 'Benutzer oder Passwort falsch' });
  req.session.loggedIn = true;
  req.session.user = ADMIN_USER;
  res.json({ ok: true, user: ADMIN_USER });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn), user: req.session?.user || null });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({ online: deviceOnline, lastSeen, status: lastStatus });
});

app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket-Server (kein eigener HTTP-Server; manuelles Upgrade-Routing) ───
const server   = http.createServer(app);
const wssDevice = new WebSocketServer({ noServer: true });
const wssApp    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

  if (pathname === '/device') {
    wssDevice.handleUpgrade(req, socket, head, (ws) => wssDevice.emit('connection', ws, req));
  } else if (pathname === '/app') {
    // Browser-Sockets brauchen eine gueltige Session (Cookie).
    sessionParser(req, {}, () => {
      if (!req.session || !req.session.loggedIn) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wssApp.handleUpgrade(req, socket, head, (ws) => wssApp.emit('connection', ws, req));
    });
  } else {
    socket.destroy();
  }
});

function broadcastToApps(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of appClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function pushDeviceState() {
  broadcastToApps({ type: 'state', online: deviceOnline, lastSeen, status: lastStatus });
}

// ── Geraeteverbindung (/device) ─────────────────────────────────────────────
wssDevice.on('connection', (ws) => {
  let authed = false;
  const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'auth timeout'); }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authed) {
      if (msg.type === 'hello' && safeEqual(msg.token || '', DEVICE_TOKEN)) {
        authed = true;
        clearTimeout(authTimer);
        deviceSocket = ws;
        deviceOnline = true;
        ws.send(JSON.stringify({ type: 'ack', ok: true }));
        console.log(`[device] verbunden (${msg.deviceId || 'unbekannt'})`);
        pushDeviceState();
      } else {
        ws.send(JSON.stringify({ type: 'ack', ok: false }));
        ws.close(4003, 'auth failed');
      }
      return;
    }

    if (msg.type === 'status') {
      lastStatus = { ...msg }; delete lastStatus.type;
      lastSeen = Date.now();
      deviceOnline = true;
      pushDeviceState();
    }
  });

  const markOffline = () => {
    clearTimeout(authTimer);
    if (deviceSocket === ws) {
      deviceSocket = null;
      deviceOnline = false;
      pushDeviceState();
      console.log('[device] getrennt');
    }
  };
  ws.on('close', markOffline);
  ws.on('error', markOffline);
});

// ── Browser-Verbindung (/app) ───────────────────────────────────────────────
wssApp.on('connection', (ws) => {
  appClients.add(ws);
  // Sofort den aktuellen Zustand schicken.
  ws.send(JSON.stringify({ type: 'state', online: deviceOnline, lastSeen, status: lastStatus }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'cmd') return;

    const action = msg.action;
    if (!VALID_ACTIONS.has(action)) return;

    // Werte-Validierung
    const out = { type: 'cmd', action };
    if (action === 'setTarget') {
      const v = Number(msg.value);
      if (!Number.isFinite(v) || v < TARGET_MIN || v > TARGET_MAX) {
        ws.send(JSON.stringify({ type: 'cmdResult', ok: false, error: 'Zieltemp ausserhalb der Grenzen' }));
        return;
      }
      out.value = Math.round(v * 100) / 100;
    }

    if (!deviceSocket || deviceSocket.readyState !== deviceSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmdResult', ok: false, error: 'Geraet offline' }));
      return;
    }
    deviceSocket.send(JSON.stringify(out));
    ws.send(JSON.stringify({ type: 'cmdResult', ok: true, action }));
    console.log(`[cmd] ${action}${out.value !== undefined ? ' = ' + out.value : ''}`);
  });

  ws.on('close', () => appClients.delete(ws));
  ws.on('error', () => appClients.delete(ws));
});

// Geraet als offline markieren, wenn lange kein Status kam (Heartbeat-Sicherung).
setInterval(() => {
  if (deviceOnline && Date.now() - lastSeen > 15000) {
    deviceOnline = false;
    pushDeviceState();
    console.log('[device] Timeout -> offline');
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`[relay] laeuft auf Port ${PORT}  ·  Nutzer: ${ADMIN_USER}`);
});
