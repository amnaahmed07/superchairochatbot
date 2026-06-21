// ============================================================================
// OpenClaw Web Chat Proxy
// ----------------------------------------------------------------------------
// Sits between your public website widget and your OpenClaw gateway.
//
// Why this exists:
//  - Your gateway token is OPERATOR level. It must NEVER touch the browser.
//  - This proxy holds the token, talks to the gateway over wss://, and exposes
//    ONE safe HTTP endpoint (POST /chat) to your website.
//  - Each website visitor gets their own isolated session, so nobody sees
//    anyone else's conversation (or your private agent:main:main history).
// ============================================================================

import express from "express";
import cors from "cors";
import WebSocket from "ws";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// CONFIG — set these as environment variables on your host (Railway/Render/VPS)
// ----------------------------------------------------------------------------
const GATEWAY_WSS   = process.env.GATEWAY_WSS   || "wss://chairo.supanova-creatives.com/";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";   // <-- Gateway Token from xCloud
const BASIC_USER    = process.env.BASIC_USER    || "";   // <-- Basic Auth User from xCloud
const BASIC_PASS    = process.env.BASIC_PASS    || "";   // <-- Basic Auth Password from xCloud

// Which website origins are allowed to call this proxy. Lock this to your site.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

const PORT = process.env.PORT || 8787;

// Agent the gateway should route to (seen in your health frame: "main").
const AGENT_ID = process.env.AGENT_ID || "main";

// How long to wait for the bot to finish answering before giving up.
const REPLY_TIMEOUT_MS = 45000;
// How often we poll chat.history while waiting for the reply.
const POLL_INTERVAL_MS = 1200;

if (!GATEWAY_TOKEN) {
  console.warn("[WARN] GATEWAY_TOKEN is empty. Set it as an env var before going live.");
}

// ----------------------------------------------------------------------------
// Gateway connection (single shared socket, auto-reconnect)
// ----------------------------------------------------------------------------
let ws = null;
let wsReady = false;
const pending = new Map(); // id -> { resolve, reject, timer }

// We captured the exact connect frame the Control UI sends. The gateway needs
// the full shape (protocol range, role, scopes, client + device blocks), or it
// silently closes the socket. We send this exact shape.
let handshakeIndex = 0;
let lockedHandshake = null;

// A stable device id for this proxy (any 64-hex string works; the gateway just
// wants a consistent identifier).
const DEVICE_ID = crypto.createHash("sha256").update("openclaw-web-proxy-device").digest("hex");

function handshakeVariants() {
  const t = GATEWAY_TOKEN;
  return [
    {
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        auth: { token: t },
        caps: ["tool-events"],
        client: {
          id: "openclaw-web-proxy",
          version: "2026.4.25",
          platform: "node",
          mode: "webchat",
        },
        device: { id: DEVICE_ID },
        locale: "en-US",
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ],
        userAgent: "openclaw-web-proxy/1.0",
      },
    },
  ];
}

function buildHeaders() {
  const headers = {};
  if (BASIC_USER || BASIC_PASS) {
    const basic = Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }
  return headers;
}

function connectGateway() {
  console.log("[gateway] connecting to", GATEWAY_WSS);
  ws = new WebSocket(GATEWAY_WSS, { headers: buildHeaders() });

  ws.on("open", () => {
    const variants = handshakeVariants();
    const frame = lockedHandshake || variants[handshakeIndex % variants.length];
    console.log(
      `[gateway] socket open. Trying handshake variant #${handshakeIndex % variants.length}:`,
      JSON.stringify({ type: frame.type, method: frame.method || "(none)" })
    );
    sendRaw(frame);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // The handshake reply tells us we're authenticated and ready.
    if (msg.type === "res" && msg.payload && msg.payload.type === "hello-ok") {
      wsReady = true;
      const variants = handshakeVariants();
      lockedHandshake = lockedHandshake || variants[handshakeIndex % variants.length];
      const role = msg.payload.auth && msg.payload.auth.role;
      console.log(`[gateway] hello-ok received. Authenticated as role="${role}". Ready. Handshake locked.`);
      return;
    }

    // If the gateway sends an explicit error response to our handshake, log it
    // so we can see exactly which field it dislikes.
    if (msg.type === "res" && msg.ok === false && !wsReady) {
      console.error("[gateway] handshake rejected:", JSON.stringify(msg.payload || msg).slice(0, 500));
      return;
    }

    // Resolve any request we're waiting on (matched by id).
    if (msg.type === "res" && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok === false) p.reject(new Error(JSON.stringify(msg.payload || msg)));
      else p.resolve(msg.payload);
      return;
    }

    // Everything else (health/node.list events) is background noise — ignore.
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = reasonBuf ? reasonBuf.toString() : "";
    console.warn(`[gateway] socket closed. code=${code} reason="${reason}"`);
    // If we closed before authenticating and we haven't locked a handshake yet,
    // advance to the next handshake variant for the next attempt.
    if (!wsReady && !lockedHandshake) {
      handshakeIndex++;
      console.warn(`[gateway] handshake not confirmed; will try variant #${handshakeIndex % handshakeVariants().length} next.`);
    }
    wsReady = false;
    ws = null;
    setTimeout(connectGateway, 3000);
  });

  ws.on("error", (err) => {
    console.error("[gateway] socket error:", err.message);
  });
}

function sendRaw(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Send a request and wait for the matching response.
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("gateway not connected"));
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`gateway timeout for ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    sendRaw({ type: "req", id, method, params });
  });
}

async function waitUntilReady(maxMs = 10000) {
  const start = Date.now();
  while (!wsReady) {
    if (Date.now() - start > maxMs) throw new Error("gateway handshake not ready");
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ----------------------------------------------------------------------------
// Helpers: extract a clean reply from a chat.history payload
// ----------------------------------------------------------------------------
// We keep ONLY type:"text" content from assistant messages, and we drop
// internal noise: thinking, toolCall, toolResult, and the HEARTBEAT_OK pings.
function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const text = message.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) return null;
  if (text === "HEARTBEAT_OK") return null; // background heartbeat, not a real reply
  if (text === "NO_REPLY" || text === "no_reply") return null;
  return text;
}

// Count how many assistant text-messages exist in a history payload.
function countAssistantReplies(historyPayload) {
  const msgs = (historyPayload && historyPayload.messages) || [];
  let n = 0;
  for (const m of msgs) {
    if (extractAssistantText(m) !== null) n++;
  }
  return n;
}

// Get the latest assistant reply text from a history payload.
function latestAssistantText(historyPayload) {
  const msgs = (historyPayload && historyPayload.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = extractAssistantText(msgs[i]);
    if (t !== null) return t;
  }
  return null;
}

// ----------------------------------------------------------------------------
// The core flow: send a message, then poll history until a NEW reply appears.
// ----------------------------------------------------------------------------
async function sendAndGetReply(sessionKey, message) {
  await waitUntilReady();

  // 1. Snapshot how many assistant replies exist BEFORE we send.
  let before;
  try {
    before = await rpc("chat.history", { sessionKey, limit: 200 });
  } catch {
    before = { messages: [] };
  }
  const baselineCount = countAssistantReplies(before);

  // 2. Send the user's message. deliver:false = we read the answer back
  //    ourselves via history (same as the Control UI does).
  await rpc("chat.send", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: crypto.randomUUID(),
  });

  // 3. Poll history until a NEW assistant reply shows up (or we time out).
  const start = Date.now();
  while (Date.now() - start < REPLY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let hist;
    try {
      hist = await rpc("chat.history", { sessionKey, limit: 200 });
    } catch {
      continue;
    }
    if (countAssistantReplies(hist) > baselineCount) {
      const reply = latestAssistantText(hist);
      if (reply) return reply;
    }
  }
  throw new Error("timed out waiting for bot reply");
}

// ----------------------------------------------------------------------------
// HTTP server — the ONLY thing your website talks to
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      if (!origin) return cb(null, true); // allow same-origin / curl
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("origin not allowed"));
    },
  })
);

// Very small in-memory rate limit per IP (protects your API costs).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60000;
  const maxPerWindow = 20;
  const rec = hits.get(ip) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + windowMs;
  }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > maxPerWindow;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, gatewayReady: wsReady });
});

app.post("/chat", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Too many messages, slow down a moment." });
  }

  const message = (req.body && req.body.message ? String(req.body.message) : "").trim();
  let visitorId = req.body && req.body.visitorId ? String(req.body.visitorId) : "";

  if (!message) return res.status(400).json({ error: "message is required" });
  if (message.length > 4000) return res.status(400).json({ error: "message too long" });

  // Give each visitor an isolated session. NEVER use agent:main:main here —
  // that is your private/shared session and would leak history to strangers.
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(visitorId)) {
    visitorId = crypto.randomUUID();
  }
  const sessionKey = `agent:${AGENT_ID}:web-${visitorId}`;

  try {
    const reply = await sendAndGetReply(sessionKey, message);
    res.json({ reply, visitorId });
  } catch (err) {
    console.error("[chat] error:", err.message);
    res.status(502).json({ error: "The assistant is unavailable right now. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] HTTP listening on :${PORT}`);
  connectGateway();
});
