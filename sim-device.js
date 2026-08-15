// ============================================================================
//  Geraete-Simulator – ersetzt den ESP32 fuer lokale Tests.
//  Verbindet sich wie das echte Geraet mit /device, sendet Status,
//  reagiert auf Befehle. Start:  node sim-device.js  [ws-url] [token]
// ============================================================================
import { WebSocket } from 'ws';

const URL   = process.argv[2] || process.env.SIM_URL   || 'ws://localhost:3000/device';
const TOKEN = process.argv[3] || process.env.DEVICE_TOKEN || 'test-token';

const st = {
  running: false, paused: false,
  waterTemp: 18.4, targetTemp: 60.0, outsideTemp: 12.1,
  elapsedSec: 0, etaUnix: 0, holdSec: 0, wifiRssi: -57,
};

let ws;
function connect(){
  ws = new WebSocket(URL);
  ws.on('open', () => {
    console.log('[sim] verbunden ->', URL);
    ws.send(JSON.stringify({ type:'hello', deviceId:'heubedampfer-sim', token:TOKEN }));
  });
  ws.on('message', (raw) => {
    let m; try{ m = JSON.parse(raw.toString()); }catch{ return; }
    if (m.type === 'ack'){ console.log('[sim] ack ok=' + m.ok); if(!m.ok) process.exit(1); return; }
    if (m.type === 'cmd'){
      console.log('[sim] Befehl:', m.action, m.value ?? '');
      if (m.action === 'start'){ st.running=true; st.paused=false; st.elapsedSec=0; }
      else if (m.action === 'stop'){ st.running=false; st.paused=false; st.elapsedSec=0; st.etaUnix=0; }
      else if (m.action === 'pause'){ st.paused=true; }
      else if (m.action === 'resume'){ st.paused=false; }
      else if (m.action === 'setTarget'){ st.targetTemp = m.value; }
      sendStatus();
    }
  });
  ws.on('close', () => { console.log('[sim] getrennt, retry in 2s'); setTimeout(connect, 2000); });
  ws.on('error', (e) => console.log('[sim] error', e.message));
}
function sendStatus(){
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type:'status', ...st }));
}

// Simulation: waehrend "running" steigt die Temperatur, Laufzeit tickt.
setInterval(() => {
  if (st.running && !st.paused){
    st.elapsedSec += 1;
    if (st.waterTemp < st.targetTemp) st.waterTemp = Math.min(st.targetTemp, st.waterTemp + 0.4);
    const remain = Math.max(1, Math.round((st.targetTemp - st.waterTemp) * 1.2));
    st.etaUnix = Math.floor(Date.now()/1000) + remain*60;
  }
}, 1000);
setInterval(sendStatus, 2000);  // wie das echte Geraet: alle 2 s

connect();
