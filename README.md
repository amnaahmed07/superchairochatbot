# OpenClaw Chatbot Backend

A small, stateless Node/Express backend that bridges a website chat widget to your
**OpenClaw** agent (`chairo` on xCloud). The browser talks plain HTTP/JSON to this
backend; the backend holds one persistent **WebSocket** connection to the OpenClaw
gateway and relays messages to/from your agent.

```
Browser (your site)  ──HTTP/JSON──►  This backend (xCloud)  ──WebSocket──►  OpenClaw gateway
   chat widget                         /api/chat                            chairo.supanova-creatives.com
```

✅ **This whole flow is verified working** against the live gateway (auth, sessions,
streaming replies, and conversation memory) — from a remote host.

## Your website visitors do NOT pair anything

Device pairing (below) is a **one-time setup for this backend only**. Visitors just
hit `/api/chat` over normal HTTP — no token, no login, no pairing. To the gateway,
all visitors look like the same single paired backend; each visitor gets their own
`sessionKey` (stored in their browser) so conversations stay separate.

## Why a backend at all?

The OpenClaw gateway speaks an authenticated WebSocket protocol and holds a secret
token. That must never be in browser code. This backend keeps the secrets server-side
and exposes a simple, CORS-friendly HTTP API.

## API

### `POST /api/chat`  (simplest)
```json
// request
{ "message": "Hello", "sessionKey": "optional-existing-session" }
// response
{ "reply": "Hi! How can I help?", "sessionKey": "agent:main:dashboard:…" }
```
Omit `sessionKey` on the first message; store the one returned and send it back on
every following turn to keep conversation memory.

### `POST /api/chat/stream`  (token-by-token, Server-Sent Events)
Same body. Streams: `session` `{sessionKey}` → `delta` `{text}` chunks → `done`
`{reply, sessionKey}` (or `error` `{error}`).

### `GET /api/health`
```json
{ "status": "ok", "gateway": "connected" }
```

## Deploy on xCloud (Deploy via Git → Node.js)

### 1. Push this folder to your Git repo
```bash
git commit -m "openclaw chatbot backend"
git remote add origin <your-repo-url>
git push -u origin main
```
`node_modules` and `.env` are gitignored — secrets never go in the repo.

### 2. Create the site in xCloud
xCloud → your server → **Add Site → Deploy via Git → Node.js**, and select your
repository (use **Private Repository** to keep the code closed).

Build/run settings:

| Field | Value |
|---|---|
| Framework / type | Node.js |
| Node version | 20 or higher |
| Install command | `npm install` |
| Start command | `npm start` |
| App port | `5000` (or whatever xCloud assigns — the app reads `PORT`) |

### 3. Add environment variables

| Variable | Value |
|---|---|
| `OPENCLAW_WS_URL` | `wss://chairo.supanova-creatives.com` |
| `OPENCLAW_TOKEN` | your gateway token |
| `OPENCLAW_ORIGIN` | `https://chairo.supanova-creatives.com` |
| `OPENCLAW_BASIC_USER` | your nginx Basic Auth user |
| `OPENCLAW_BASIC_PASS` | your nginx Basic Auth password |
| `OPENCLAW_DEVICE_KEY` | the base64 device key (see `.env.example`) |
| `CORS_ORIGINS` | your website domain (e.g. `https://supanovacreatives.com`) |

> **Note:** these are needed because the backend runs on a *different* server than the
> OpenClaw gateway, so it connects remotely (Basic Auth + signed device identity).
> If you ever run it on the **same** server as the gateway, drop the device key,
> Basic Auth and Origin entirely and just set `OPENCLAW_WS_URL=ws://127.0.0.1:18789`.

### 4. Approve the device ONCE
On first boot the logs will show **"DEVICE PAIRING REQUIRED"** with a device id. Open
your **Control UI** (the `https://chairo.supanova-creatives.com?token=…` URL from
xCloud → OpenClaw → Status) and approve that device. The backend retries every 10s and
connects automatically once approved. After that it reuses a device token — no more
approvals, even across restarts (as long as `OPENCLAW_DEVICE_KEY` stays the same).

> No device key ships with this repo — generate your own and keep it out of git.
> It prints the id to approve and the value for `OPENCLAW_DEVICE_KEY`:
> `node -e "const d=require('./src/deviceIdentity');const i=d.generateIdentity();console.log('id',i.deviceId);console.log('key',Buffer.from(i.privateKeyPem).toString('base64'))"`

### 5. Verify
Open `https://your-site-domain/api/health` → should say `gateway: connected`.

## Frontend integration (Hostinger)

Replace `BACKEND` with your xCloud site URL.

```html
<script>
const BACKEND = 'https://your-site-domain';
let sessionKey = localStorage.getItem('clawSession') || null;

async function sendMessage(text) {
  const res = await fetch(`${BACKEND}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, sessionKey }),
  });
  const data = await res.json();
  if (data.sessionKey) { sessionKey = data.sessionKey; localStorage.setItem('clawSession', sessionKey); }
  return data.reply;
}

// streaming version (token-by-token)
async function sendMessageStream(text, onChunk) {
  const res = await fetch(`${BACKEND}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, sessionKey }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const ev = part.match(/event: (.*)/)?.[1];
      const data = JSON.parse(part.match(/data: (.*)/)?.[1] || '{}');
      if (ev === 'session' && data.sessionKey) { sessionKey = data.sessionKey; localStorage.setItem('clawSession', sessionKey); }
      else if (ev === 'delta') onChunk(data.text);
    }
  }
}
</script>
```

## How it works (verified protocol)

| Step | Gateway call |
|------|--------------|
| Handshake | `connect` with `client.id:"cli"`, `client.mode:"backend"`, `role:"operator"`, `auth.token` + signed Ed25519 `device` block |
| Start a conversation | `sessions.create` → returns `key` (the sessionKey) |
| Subscribe to replies | `sessions.messages.subscribe` `{ key }` |
| Send a user message | `chat.send` `{ sessionKey, message, idempotencyKey }` |
| Receive the reply | `chat` events with `state` `delta`→`final`, text in `message.content[]` |

Default agent is `main`. First replies can take a while (large context injection), so
the request timeout is 180s and a 4s idle-quiet fallback closes the turn after the last
token. Tune with `OPENCLAW_REQUEST_TIMEOUT_MS` / `OPENCLAW_IDLE_COMPLETION_MS`.

## Files

- `src/openclawClient.js` — gateway WS client (handshake, device auth, sessions, streaming, reconnect)
- `src/deviceIdentity.js` — Ed25519 device identity + V3 signature (matches OpenClaw exactly)
- `src/routes/chat.js` — `/api/chat`, `/api/chat/stream`, `/api/health`
- `src/config.js`, `src/index.js` — config + Express app
- `scripts/discover.js` — dump raw gateway frames (debugging)
- `test/smoke.js` — end-to-end test (`BASE_URL=… node test/smoke.js "hi"`)

## Security note

The gateway token and Basic Auth password are sensitive. They live only in env vars
(never in the frontend). Consider rotating them in xCloud after setup since they were
shared during development. The `OPENCLAW_DEVICE_KEY` is also a credential — keep it in
xCloud's environment variables.
