# PTT — LAN Push-to-Talk Walkie-Talkie

A local-network push-to-talk (PTT) walkie-talkie web app. One laptop runs a
Node.js server (optionally with a Wi-Fi hotspot), and phones and laptops on the
same network open the app in a browser, join a channel, and talk to each other
by holding a PTT button.

Audio is captured in the browser, encoded with Opus (via MediaRecorder), sent
to the Node.js server over Socket.IO, and relayed to all other members of the
same channel. **No WebRTC, no peer-to-peer — server relay only.** Half-duplex
is enforced by the server: only one device per channel can transmit at a time.

---

## Features

- Four hardcoded channels: **ALPHA**, **BRAVO**, **CHARLIE**, **DELTA**
- Half-duplex: only one transmitter per channel; others see `CHANNEL BUSY`
- Hold-to-talk PTT: touch and mouse, with edge-case handling
  (finger slides off, tab blur, screen lock, POWER off mid-transmission)
- Two views:
  - **Mobile** (< 768 px): large circular PTT, channel name, live clock, no clutter
  - **Desktop** (≥ 768 px): same layout plus a live `CONNECTED UNITS` panel
    (device ID, channel, IP) sourced from the server
- On/Off POWER button: fully disconnects, releases mic, removes device from list
- Live clock in `HH:MM:SS` 24-hour format
- Optional HTTPS (required for microphone access on phones over LAN)
- Military-console design: pure black, amber, NATO green, signal red, monospace

---

## Tech stack

- **Backend:** Node.js, Express, Socket.IO (single-file `server.js`)
- **Frontend:** plain HTML + CSS + Vanilla JavaScript (no build step)
- **Transport:** Socket.IO (server-relayed, no WebRTC)
- **Encoding:** Opus via `MediaRecorder` (falls back to whatever the browser
  supports); one continuous clip per transmission ("record-then-send")

---

## Project structure

```
ptt-app/
  server.js
  package.json
  README.md
  LICENSE
  .gitignore
  public/
    index.html
    style.css
    app.js
  # Optional, not committed:
  cert.pem
  key.pem
```

---

## Prerequisites

- **Node.js** 18 or newer (`node -v` to check)
- A **Wi-Fi network** the laptop and all phones are on together
  (home router, or a Wi-Fi hotspot the laptop creates)
- **mkcert** (only if you want phones to use the microphone — see *HTTPS* below)

---

## Quick start (laptop only, no HTTPS)

```bash
git clone <this-repo-url> ptt-app
cd ptt-app
npm install
npm start
```

You should see:

```
PTT server listening on http://0.0.0.0:3000
WARNING: no cert.pem / key.pem found — serving over HTTP.
         Phones on LAN will NOT be able to access the microphone.
         Generate certs with mkcert (see README / step 6) to enable HTTPS.
```

Open **http://localhost:3000** on the laptop. You can use the app fully from
two browser windows on the laptop itself — the mic works on `localhost`
without HTTPS.

**Mic access will not work on any other device over plain HTTP.** That's a
browser security requirement, not a bug. For phone use, follow the *HTTPS*
section next.

---

## HTTPS (required for microphone access on phones)

Browsers only allow `navigator.mediaDevices.getUserMedia` over HTTPS or
`localhost`. On a LAN, `http://192.168.x.x` is neither, so mic is silently
blocked. Fix it once with **mkcert** — a local certificate authority you
install on the phone. After that, `https://192.168.x.x:3000` works with a lock
icon, mic prompt, everything.

### 1. Install mkcert on the laptop

**Windows (Chocolatey):**
```powershell
choco install mkcert
```

**macOS (Homebrew):**
```bash
brew install mkcert
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install mkcert
```

Alternatively download the binary from
https://github.com/FiloSottile/mkcert/releases and place it on your `PATH`.

### 2. Install the local root CA on the laptop

```bash
mkcert -install
```

Accept the OS prompt. This creates a local root CA and installs it in the
system trust store.

### 3. Find the laptop's LAN IP

**Windows:**
```cmd
ipconfig
```

**macOS / Linux:**
```bash
ipconfig getifaddr en0     # macOS Wi-Fi
hostname -I                # Linux
```

Look for the IPv4 address of the active Wi-Fi or Ethernet adapter. It will
look like `192.168.1.112` or `192.168.137.1` (Windows hotspot). Note it down —
you'll use it everywhere below.

### 4. Generate the cert (include the LAN IP)

Run in the `ptt-app` folder:

```bash
mkcert localhost 127.0.0.1 <YOUR-LAN-IP>
```

Example:

```bash
mkcert localhost 127.0.0.1 192.168.1.112
```

mkcert prints two filenames, e.g. `localhost+2.pem` and `localhost+2-key.pem`.
Rename them so the server finds them:

**Windows:**
```cmd
del cert.pem key.pem 2>nul
ren localhost+2.pem cert.pem
ren localhost+2-key.pem key.pem
```

**macOS / Linux:**
```bash
mv localhost+2.pem cert.pem
mv localhost+2-key.pem key.pem
```

(Replace `localhost+2` with whatever mkcert actually printed.)

### 5. Restart the server

```bash
npm start
```

You should now see:

```
PTT server listening on https://0.0.0.0:3000
Microphone access enabled on phones (HTTPS).
Open https://<your-lan-ip>:3000 on phones after trusting the cert.
HTTP redirect listening on http://0.0.0.0:3001 -> https://*:3000
```

The server also runs a tiny HTTP listener on port `3001` that redirects to
`https://…:3000`, so if a phone types the HTTP address it gets bounced to HTTPS.

### 6. Open Windows Firewall for ports 3000 and 3001

On Windows, ports are blocked by default unless you allow them. In an
**Administrator** CMD/Terminal:

```cmd
netsh advfirewall firewall add rule name="PTT App 3000" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="PTT App 3001" dir=in action=allow protocol=TCP localport=3001
```

(macOS / Linux users: no action needed in a typical home network.)

### 7. Trust the mkcert root CA on each phone

Find the root CA file:

```bash
mkcert -CAROOT
```

That prints a folder, e.g. `C:\Users\you\AppData\Local\mkcert` or
`~/Library/Application Support/mkcert`. Inside is `rootCA.pem`. Copy that file
to the phone (email attachment, AirDrop, cloud drive — anything).

**Android (Chrome):**
1. Open the `rootCA.pem` file → Android offers "Install certificate" →
   choose **CA certificate** → "Install anyway" → confirm.
2. Open `https://<YOUR-LAN-IP>:3000` in Chrome.
3. If a warning appears, tap **Advanced → Proceed**. You only need to do this
   once per origin.
4. Press PTT → Chrome shows the **microphone permission prompt** → Allow.

**iOS (Safari):**
1. Open `rootCA.pem` on the phone → "Profile Downloaded" → Settings →
   **General → VPN & Device Management** → install the profile → enter passcode.
2. Settings → General → About → **Certificate Trust Settings** → toggle **ON**
   for mkcert.
3. Open `https://<YOUR-LAN-IP>:3000` in Safari → lock icon, no warning.
4. Press PTT → Safari shows the mic prompt → Allow.

Once trusted, the phone will remember it forever. Every phone you add needs to
repeat steps 1–2.

---

## Using the app

Open `https://<YOUR-LAN-IP>:3000` (or `http://localhost:3000` on the laptop).

### Main view

```
CHANNEL              LOCAL
ALPHA                14:23:07
─────────────────────────────
■ READY
─────────────────────────────
              ◯
         HOLD TO TALK
─────────────────────────────
[ CHANNEL ]    [ POWER ON ]
```

- **CHANNEL** opens the channel-select screen.
- **POWER** toggles your connection to the server. When off, your device
  disappears from other devices' lists and the microphone stream is released.
  Toggling back on puts you on the channel-select screen.
- **Hold PTT** to talk. Release to stop. Only one device per channel can talk
  at a time.

### Status indicators

| Dot | Text | Meaning |
|-----|------|---------|
| ■ amber | `READY` | Idle, can transmit |
| ■ amber | `TRANSMITTING` | You are transmitting |
| ■ red | `RX — <ID>` / `CHANNEL BUSY` | Someone else on your channel is transmitting |
| ■ gray | `OFFLINE` / `NO CHANNEL` | POWER off, or not in a channel |
| ■ red | `MIC ERROR` | Microphone permission denied / unavailable |

### Channel select

Four large buttons — ALPHA, BRAVO, CHARLIE, DELTA — plus a BACK button.
Tapping a channel joins it and returns to the main view. Switching channels
mid-session leaves the previous channel instantly.

### Desktop view

Adds a **CONNECTED UNITS** panel on the right showing every device currently
connected to the app (whether in a channel or on channel-select):
short device ID, channel, and IP address. Updates live as devices join,
leave, or change channels. The current transmitter is highlighted in amber.

### Behaviour notes

- **Half-duplex:** if someone on your channel is transmitting, your PTT is
  disabled and shows `CHANNEL BUSY`. The server is the source of truth; a
  simultaneous second PTT is rejected.
- **Release edge cases:** releasing the PTT button, sliding the finger off,
  tab blur, screen lock, POWER off, and page close all stop transmission and
  clear BUSY cleanly.
- **Audio latency:** the app uses **record-then-send** — one continuous Opus
  clip per transmission. Receivers hear the full utterance played once after
  you release. This is deliberate: it's reliable across Chrome, Edge, Safari,
  and Firefox without a MediaSource muxer, and it matches how short radio
  voice messages feel. Not suitable for continuous live streaming.
- **Audio bitrate:** 24 kbps Opus. A 5-second transmission is roughly 15 KB.
  Cap per transmission is 30 seconds.

---

## Acceptance test

Open the app on **four devices** (one laptop + three phones is typical). Use
headphones to avoid feedback.

### 1. Four devices, four channels

- Device A → ALPHA
- Device B → BRAVO
- Device C → CHARLIE
- Device D → DELTA

On the desktop's `CONNECTED UNITS` panel: four rows, four different channels,
four different IPs. Each device shows `READY` on its main view.

### 2. Channel isolation

- A holds PTT and says "ALPHA test".
- B, C, D see **no** `CHANNEL BUSY` and hear **nothing**.
- A hears no playback (sender never plays their own audio).

### 3. Half-duplex on the same channel

- A and B both join ALPHA.
- A holds PTT for 2 s. B's status shows `RX — <A-id>` and its PTT is disabled.
- B tries to press PTT while A holds → nothing happens (button is disabled
  and the server would reject `ptt:start` anyway).
- A releases → both return to `READY` within ~1 s. B hears A's clip in full.

### 4. Device list accuracy

- With all four devices connected, the CONNECTED UNITS panel shows all four.
- Toggle POWER off on device B → B's row disappears from A/C/D's panels
  within ~1 s.
- Toggle POWER back on → B reappears, channel `—` (not auto-rejoined).
- On device C, tap CHANNEL → CHARLIE. Its row in the panel updates to
  `CHARLIE` within ~1 s.

### 5. POWER off / mic release

- Device A holds PTT.
- While A is transmitting, toggle A's POWER off.
- A's mic indicator in the OS is gone (mic stream released).
- B returns to `READY` within ~1 s.
- A disappears from the device list within ~1 s.

### 6. Clock

- Both the main view clock and the channel-select clock tick every second
  in `HH:MM:SS` (24-hour, no AM/PM).

### 7. Release edge cases

- **Finger slide-off:** hold PTT, drag finger off the button, release → stops.
- **Tab blur:** hold PTT, Alt+Tab away → stops.
- **Screen lock:** hold PTT, lock the phone → transmission stops on return.
- **POWER off mid-transmission:** see test 5.

All seven pass → the app works as specified.

---

## Troubleshooting

### Phone says "This site can't be reached"

- Laptop and phone must be on the **same Wi-Fi SSID**. Guest networks and
  mobile data won't work.
- Confirm the laptop's IPv4 address with `ipconfig` / `hostname -I`.
  If it changed, regenerate the cert to include the new IP.
- On Windows, confirm the firewall rules for ports 3000 and 3001 exist
  (see *HTTPS §6*).

### Phone says "Your connection is not private"

The mkcert root CA is not installed or not trusted on that phone. Revisit
*HTTPS §7* for the phone's OS.

### Mic prompt never appears / `MIC ERROR` on PTT

- URL must be `https://…` **or** `localhost`. Plain HTTP on a LAN IP is
  blocked by the browser.
- If you previously denied mic permission for this origin:
  - **Chrome Android:** tap the lock icon in the URL bar → Permissions →
    Microphone → Allow.
  - **iOS Safari:** Settings → Safari → Microphone → Allow.
- The URL bar must show a **lock icon**, not a warning triangle. If it
  shows a warning, the cert trust step is incomplete.

### Receiver hears the first syllable and then nothing

Very old browsers with non-standard MediaRecorder behaviour. The app uses
record-then-send specifically to avoid this; make sure you are on a recent
Chrome / Edge / Safari / Firefox.

### No sound at all

- Verify the device list shows the transmitting device turning amber while
  PTT is held (server sees the `ptt:start`).
- Check the browser console on both ends; you should see `[app] emitted
  audio bytes= …` on the transmitter and `[app] playIncomingClip …` on the
  receiver.
- Check the server terminal: it logs `audio relayed: from=… channel=… bytes=…`.

---

## Development

```bash
npm install       # first time
npm start         # runs `node server.js`
```

No build step. Edit `public/index.html`, `public/style.css`, `public/app.js`,
and reload. The server sets `Cache-Control: no-store` on JS/HTML/CSS so a
normal reload always picks up changes.

- **Server state** lives in `server.js`:
  - `devices[id] = { socketId, channel, ip, isTransmitting }`
  - `channels[NAME] = { busyBy, lastSender, lastSendAt }`
- **Socket.IO protocol** (client ↔ server):
  - C→S: `join { channel }`, `leave`, `ptt:start`, `ptt:stop`,
    `audio { mimeType, data }`, `disconnect` (built-in)
  - S→C: `joined { deviceId, channel? }`, `channel:busy { byDeviceId }`,
    `channel:free`, `devices:update [{ id, channel, ip, isTransmitting }]`,
    `audio { fromDeviceId, mimeType, data }`, `error { message }`

---

## Security note

This app is designed for a **trusted local network** — a home Wi-Fi, a
corporate LAN, or a laptop hotspot. It performs **no authentication**, has
**no encryption beyond what HTTPS provides**, and relays audio between any
connected clients on the same channel. **Do not expose it to the public
internet** as-is.

---

## License

MIT — see [LICENSE](./LICENSE).