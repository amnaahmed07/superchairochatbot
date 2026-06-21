# OpenClaw Website Chat Widget — Setup Guide

This gives you a bottom-right chat widget on your HTML website, backed by your
OpenClaw bot. There are two pieces:

1. **server.js** — a small proxy you deploy once. It holds your secret token and
   talks to the gateway. Your website never sees the token.
2. **widget.html** — a snippet you paste into your website.

---

## Why a proxy at all?

Your gateway token is **operator level** (full admin). It cannot go in browser
code where anyone can read it. The proxy keeps it server-side and only ever lets
the website do two safe things: send a chat message and read the reply.

It also gives **each visitor their own private session**, so strangers never see
your `agent:main:main` history (which contains real emails/conversations).

---

## STEP 1 — Deploy the proxy (Railway is the easiest)

You need an always-on host (NOT classic serverless — this holds a live socket).
Railway or Render both work and have a free/cheap tier.

### Using Railway
1. Make a free account at railway.app.
2. New Project → "Deploy from local" (or push these files to a GitHub repo and
   "Deploy from GitHub").
3. Upload/point it at this folder (package.json + server.js).
4. In the project's **Variables** tab, add these environment variables:

   | Name             | Value                                              |
   |------------------|----------------------------------------------------|
   | GATEWAY_WSS      | wss://chairo.supanova-creatives.com/               |
   | GATEWAY_TOKEN    | (paste your Gateway Token from xCloud)             |
   | BASIC_USER       | (paste Basic Auth User from xCloud)               |
   | BASIC_PASS       | (paste Basic Auth Password from xCloud)           |
   | ALLOWED_ORIGINS  | https://your-website.com                            |
   | AGENT_ID         | main                                               |

5. Deploy. Railway gives you a public URL like
   `https://your-proxy.up.railway.app`.

### Check it works
Open `https://your-proxy.up.railway.app/health` in a browser.
You want to see: `{"ok":true,"gatewayReady":true}`

- `gatewayReady:true` = the proxy connected and authenticated. 
- `gatewayReady:false` = check the deploy logs. If you see an auth error after
  "sending connect handshake", the connect frame format needs a tiny tweak — the
  log will show what the gateway expects (see Troubleshooting).

---

## STEP 2 — Add the widget to your website

1. Open `widget.html`.
2. Change ONE line near the top:
   ```js
   var PROXY_URL = "https://your-proxy.up.railway.app/chat";
   ```
3. Optionally change `BOT_NAME` and `WELCOME`.
4. Copy the whole block and paste it into your site's HTML, **just before
   `</body>`**.

Reload your site — a chat bubble appears bottom-right.

---

## STEP 3 — Lock it down (do this before real traffic)

- Set `ALLOWED_ORIGINS` to your exact site origin (not `*`).
- The proxy already rate-limits to 20 messages/min per IP. Adjust in server.js
  if needed.
- Keep your token secret. If it ever leaks, rotate it from the xCloud Reset
  panel and update the env var.

---

## Troubleshooting

**/health shows gatewayReady:false, log shows an auth error**
The outgoing connect frame is the one part we reconstructed. OpenClaw builds vary
between two shapes. If the default fails, in server.js find the `connect` frame
in `ws.on("open")` and try the alternative:
```js
// Alternative handshake shape:
sendRaw({ type: "req", id: crypto.randomUUID(), method: "hello",
          params: { protocol: 3, auth: { token: GATEWAY_TOKEN } } });
```
The gateway's error reply (printed in logs) names the field it actually wants.

**Bot replies in Control UI but widget times out**
Increase `REPLY_TIMEOUT_MS`. Some answers take longer (tool calls).

**Widget shows "couldn't reach server"**
PROXY_URL is wrong, or CORS blocked it — confirm ALLOWED_ORIGINS includes your
site's exact origin (scheme + domain, no trailing slash).
