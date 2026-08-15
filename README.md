# Heubedampfer-Relay

Server + Web-App für die Fernsteuerung. Das Gerät (ESP32) verbindet sich **ausgehend**
per WebSocket, der Browser spricht nur mit diesem Server. Dadurch ist der Bedampfer
**von überall** erreichbar, ohne Portfreigabe am Stall-Router.

```
ESP32  --wss://DOMAIN/device-->  [ Relay ]  <--wss://DOMAIN/app--  Browser (Login)
           (Token)                                (Session-Cookie)
```

## Bestandteile
- `server.js` – Node-Relay: `/device`-WS (Token-Auth), `/app`-WS (Login-Auth), Login-API, liefert die Web-App.
- `public/index.html` – Web-App: Login → Dashboard (Live-Status + Steuerung, Start mit Bestätigung).
- `sim-device.js` – Geräte-Simulator für lokale Tests (ersetzt den ESP32).
- `Dockerfile` – für das Coolify-Deployment.

## Environment-Variablen (in Coolify setzen)
| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DEVICE_TOKEN` | **ja** | Geheimer Token, den das Gerät beim Verbinden vorzeigt. Lang & zufällig. |
| `ADMIN_USER` | – | Login-Benutzer (Default `admin`). |
| `ADMIN_PASS` | **ja** | Login-Passwort. |
| `SESSION_SECRET` | empfohlen | Signiert die Session-Cookies. Lang & zufällig (sonst zufällig pro Start → Logins gehen bei Neustart verloren). |
| `TARGET_MIN` / `TARGET_MAX` | – | Erlaubter Zieltemp-Bereich (Default 0 / 99). |
| `PORT` | – | Container-Port (Default 3000). |

Zufalls-Secret erzeugen: `openssl rand -hex 32` (oder `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

## Deployment mit Coolify
1. Diesen `server/`-Ordner in ein **Git-Repo** legen (GitHub/GitLab), auf das Coolify Zugriff hat.
2. Coolify → **New Resource → Application** → dein Repo wählen. Coolify erkennt das `Dockerfile` automatisch.
3. **Port** auf `3000` stellen (Ports/Networking).
4. **Domain** eintragen (deine Domain) → Coolify holt automatisch das **HTTPS-Zertifikat** (Let's Encrypt). WebSocket-Upgrade macht der Coolify-Proxy (Traefik) von selbst — nichts extra nötig.
5. **Environment-Variablen** aus der Tabelle oben eintragen (mindestens `DEVICE_TOKEN`, `ADMIN_PASS`, `SESSION_SECRET`).
6. **Deploy**. Danach:
   - Web-App: `https://DEINE-DOMAIN/` → einloggen.
   - Gerät verbindet sich zu `wss://DEINE-DOMAIN/device` (kommt im Firmware-Schritt).

## Lokal testen
```bash
npm install
DEVICE_TOKEN=test-token ADMIN_PASS=test123 SESSION_SECRET=dev npm start
# in einem zweiten Terminal – simuliertes Gerät:
DEVICE_TOKEN=test-token npm run sim
# Browser: http://localhost:3000  (admin / test123)
```

## Sicherheit
- **TLS**: Alles läuft über `https`/`wss` (Coolify terminiert TLS). Cookies sind `secure`+`httpOnly`.
- **Gerät**: Token-Auth; falscher/kein Token → Verbindung wird sofort getrennt.
- **Nutzer**: Login-Pflicht für die Web-App und für Befehle. Aktuell ein Nutzer (später erweiterbar).
- **Heizgerät**: **Stop** geht sofort, **Start** nur mit Bestätigung in der App. Zieltemp wird serverseitig auf `TARGET_MIN..MAX` geprüft.
- Empfehlung: `ADMIN_PASS` später auf einen bcrypt-Hash umstellen, wenn mehr Nutzer dazukommen.
