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
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
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
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';   // optional (Push aus)
const TG_CHAT        = process.env.TELEGRAM_CHAT_ID   || '';

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
let lastSettings = null;                 // letzte Einstellungen vom Geraet
let lastWifi     = null;                 // letzter WLAN-Zustand vom Geraet
let lastSeen     = 0;                    // millis des letzten Statuspakets
const appClients = new Set();            // eingeloggte Browser-Sockets

// ── Telegram-Push (optional, nur wenn Env gesetzt) ──────────────────────────
const NOTIFY_FILE = path.join(__dirname, 'notify.json');
let notifyCfg = { done: true, offline: true, startstop: true, target: true };
try { notifyCfg = { ...notifyCfg, ...JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')) }; } catch {}
function saveNotifyCfg() { try { fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifyCfg)); } catch {} }
const tgEnabled = () => !!(TG_TOKEN && TG_CHAT);

async function sendTelegram(text) {
  if (!tgEnabled()) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!r.ok) console.error('[telegram] HTTP', r.status);
    return r.ok;
  } catch (e) { console.error('[telegram]', e.message); return false; }
}
// Sendet nur, wenn der Ereignistyp in den App-Einstellungen aktiv ist.
function notify(kind, text) { if (notifyCfg[kind]) sendTelegram(text); }

// Ereigniserkennung aus dem Status-Stream (Flankenerkennung)
const ev = { running: false, endPending: false, targetHit: false, online: false };
function fmtTemp(x) { return (x == null || x <= -100) ? '—' : (Math.round(x * 10) / 10).toString().replace('.', ',') + ' °C'; }
function detectStatusEvents(s) {
  if (!s) return;
  const running = !!s.running;
  if (running && !ev.running) { ev.targetHit = false; notify('startstop', '▶️ Bedampfung <b>gestartet</b>'); }
  if (!running && ev.running) { notify('startstop', '⏹️ Bedampfung <b>gestoppt</b>'); }
  if (!!s.endPending && !ev.endPending) {
    notify('done', `✅ <b>Bedampfung fertig</b>\nMax. ${fmtTemp(s.endMaxTemp)} · End ${fmtTemp(s.endFinalTemp)}`);
  }
  if (running && !ev.targetHit && typeof s.waterTemp === 'number' && typeof s.targetTemp === 'number'
      && s.waterTemp > -100 && s.waterTemp >= s.targetTemp) {
    ev.targetHit = true;
    notify('target', `🌡️ <b>Zieltemperatur erreicht</b> (${fmtTemp(s.waterTemp)})`);
  }
  ev.running = running; ev.endPending = !!s.endPending;
}
function detectOnlineEvent(nowOnline) {
  if (nowOnline === ev.online) return;
  ev.online = nowOnline;
  if (nowOnline) notify('offline', '🟢 Heubedampfer wieder <b>online</b>');
  else           notify('offline', '🔴 Heubedampfer <b>offline</b> (keine Verbindung)');
}

const VALID_ACTIONS = new Set([
  'start', 'stop', 'pause', 'resume', 'setTarget', 'confirmEnd',
  'getSettings', 'getPower', 'setMaxDur', 'setHoldDur', 'setWeekday',
  'setMelody', 'setPowerCfg', 'downloadSong', 'clearPower',
  'getWifi', 'addWifi', 'removeWifi', 'setPin', 'otaUpdate'
]);

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

// ── Benachrichtigungs-Einstellungen (Telegram) ──────────────────────────────
app.get('/api/notify', requireAuth, (req, res) => {
  res.json({ configured: tgEnabled(), settings: notifyCfg });
});
app.post('/api/notify', requireAuth, (req, res) => {
  const b = req.body || {};
  for (const k of ['done', 'offline', 'startstop', 'target']) {
    if (typeof b[k] === 'boolean') notifyCfg[k] = b[k];
  }
  saveNotifyCfg();
  res.json({ ok: true, configured: tgEnabled(), settings: notifyCfg });
});
app.post('/api/notify/test', requireAuth, async (req, res) => {
  if (!tgEnabled()) return res.status(400).json({ error: 'Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in Coolify setzen)' });
  const ok = await sendTelegram('🔔 Testnachricht vom Heubedampfer — Push funktioniert!');
  res.json({ ok });
});

// ── Song-Upload (Option B): Datei annehmen, oeffentliche URL zurueckgeben ────
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/upload-song', requireAuth, upload.single('song'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei erhalten' });
  const cleaned  = (req.file.originalname || 'song.mp3').replace(/[^\w.\- ]/g, '_').slice(0, 60);
  const safeName = cleaned.replace(/\s+/g, '_');
  const stored   = Date.now().toString(36) + '_' + safeName;
  fs.renameSync(req.file.path, path.join(uploadsDir, stored));
  const base = req.protocol + '://' + req.get('host');
  res.json({ ok: true, name: safeName, url: base + '/uploads/' + encodeURIComponent(stored) });
});

// Uploads oeffentlich servieren, damit das Geraet sie per HTTPS herunterladen kann.
app.use('/uploads', express.static(uploadsDir, { maxAge: '10m' }));

// ── Firmware-Upload (Remote-OTA): .bin annehmen, oeffentliche URL zurueckgeben ──
const firmwareDir = path.join(__dirname, 'firmware');
fs.mkdirSync(firmwareDir, { recursive: true });
const fwUpload = multer({ dest: firmwareDir, limits: { fileSize: 6 * 1024 * 1024 } });

app.post('/api/upload-firmware', requireAuth, fwUpload.single('firmware'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei erhalten' });
  const orig = req.file.originalname || 'firmware.bin';
  if (!/\.bin$/i.test(orig)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Nur .bin-Dateien erlaubt' });
  }
  const stored = Date.now().toString(36) + '.bin';
  fs.renameSync(req.file.path, path.join(firmwareDir, stored));
  // Nur die neueste Firmware behalten (alte .bin aufraeumen)
  try {
    for (const f of fs.readdirSync(firmwareDir)) {
      if (f !== stored) fs.unlinkSync(path.join(firmwareDir, f));
    }
  } catch {}
  const base = req.protocol + '://' + req.get('host');
  res.json({ ok: true, url: base + '/firmware/' + stored, size: req.file.size });
});

// Firmware oeffentlich servieren, damit das Geraet sie per HTTPS laden kann.
app.use('/firmware', express.static(firmwareDir, { maxAge: '5m' }));

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
        detectOnlineEvent(true);
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
      detectOnlineEvent(true);
      detectStatusEvents(lastStatus);
      pushDeviceState();
    } else if (msg.type === 'settings') {
      lastSettings = { ...msg }; delete lastSettings.type;
      broadcastToApps({ type: 'settings', settings: lastSettings });
    } else if (msg.type === 'power') {
      const p = { ...msg }; delete p.type;
      broadcastToApps({ type: 'power', power: p });
    } else if (msg.type === 'wifi') {
      lastWifi = { ...msg }; delete lastWifi.type;
      broadcastToApps({ type: 'wifi', wifi: lastWifi });
    } else if (msg.type === 'wifiResult') {
      broadcastToApps({ type: 'wifiResult', ok: !!msg.ok, error: msg.error || null });
    } else if (msg.type === 'otaProgress') {
      broadcastToApps({ type: 'otaProgress', pct: msg.pct });
    } else if (msg.type === 'otaResult') {
      broadcastToApps({ type: 'otaResult', ok: !!msg.ok, error: msg.error || null });
    }
  });

  const markOffline = () => {
    clearTimeout(authTimer);
    if (deviceSocket === ws) {
      deviceSocket = null;
      deviceOnline = false;
      detectOnlineEvent(false);
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
  // Sofort aktuellen Zustand + Einstellungen schicken.
  ws.send(JSON.stringify({ type: 'state', online: deviceOnline, lastSeen, status: lastStatus }));
  if (lastSettings) ws.send(JSON.stringify({ type: 'settings', settings: lastSettings }));
  if (lastWifi)     ws.send(JSON.stringify({ type: 'wifi', wifi: lastWifi }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'cmd') return;

    const action = msg.action;
    if (!VALID_ACTIONS.has(action)) return;

    // Werte-Validierung / Aufbau des weiterzuleitenden Befehls
    let out;
    if (action === 'setTarget') {
      const v = Number(msg.value);
      if (!Number.isFinite(v) || v < TARGET_MIN || v > TARGET_MAX) {
        ws.send(JSON.stringify({ type: 'cmdResult', ok: false, error: 'Zieltemp ausserhalb der Grenzen' }));
        return;
      }
      out = { type: 'cmd', action, value: Math.round(v * 100) / 100 };
    } else {
      // uebrige Befehle (Nutzer ist eingeloggt) mit allen Parametern 1:1 durchreichen
      out = { ...msg, type: 'cmd', action };
    }

    if (!deviceSocket || deviceSocket.readyState !== deviceSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmdResult', ok: false, error: 'Geraet offline' }));
      return;
    }
    deviceSocket.send(JSON.stringify(out));
    ws.send(JSON.stringify({ type: 'cmdResult', ok: true, action }));
    console.log(`[cmd] ${action}`);
  });

  ws.on('close', () => appClients.delete(ws));
  ws.on('error', () => appClients.delete(ws));
});

// Geraet als offline markieren, wenn lange kein Status kam (Heartbeat-Sicherung).
setInterval(() => {
  if (deviceOnline && Date.now() - lastSeen > 15000) {
    deviceOnline = false;
    detectOnlineEvent(false);
    pushDeviceState();
    console.log('[device] Timeout -> offline');
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`[relay] laeuft auf Port ${PORT}  ·  Nutzer: ${ADMIN_USER}`);
});
