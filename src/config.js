require('dotenv').config();

/**
 * All configuration is read from environment variables so the same build can be
 * deployed to Railway / Render / anywhere without code changes.
 *
 * The only two values you MUST set are:
 *   - OPENCLAW_WS_URL    (the gateway WebSocket URL)
 *   - OPENCLAW_TOKEN     (the gateway auth token)
 */

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  // ── HTTP server ────────────────────────────────────────────────────────────
  port: int(process.env.PORT, 5000),

  // Comma-separated list of origins allowed to call this backend from a browser.
  // e.g. "https://your-store.hostinger.site,https://www.your-store.com"
  // Use "*" to allow any origin (fine while testing, lock it down in prod).
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── OpenClaw gateway ───────────────────────────────────────────────────────
  openclaw: {
    // The gateway WebSocket endpoint. The gateway is `bind: loopback` on port
    // 18789, so the ONLY way to get full operator scopes from the token is to
    // run this backend ON THE SAME xCloud server and connect over loopback:
    //   ws://127.0.0.1:18789   (default — recommended)
    //
    // Remote clients (e.g. via wss://chairo.supanova-creatives.com) authenticate
    // but receive zero scopes unless they complete Ed25519 device pairing, so the
    // loopback deployment is the supported path for this config.
    wsUrl: process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',

    // Gateway auth token (config.gateway.auth.token / gateway.remote.token).
    token: process.env.OPENCLAW_TOKEN || '',

    // Origin header for the WS upgrade. Not needed for loopback backend clients.
    // Only set this if you connect through the public nginx endpoint, where the
    // gateway validates Origin against controlUi.allowedOrigins.
    origin: process.env.OPENCLAW_ORIGIN || '',

    // nginx HTTP Basic Auth ("Restricted Area") credentials. Only needed if you
    // connect through the public domain rather than loopback. Leave blank for
    // the loopback deployment.
    basicUser: process.env.OPENCLAW_BASIC_USER || '',
    basicPass: process.env.OPENCLAW_BASIC_PASS || '',

    // ── REMOTE device identity (Railway / off-server hosting) ─────────────────
    // base64 of the Ed25519 private key PEM. Setting this switches the client to
    // signed device-auth mode (required to get scopes from a remote connection).
    // The device must be approved ONCE in the Control UI; after that the gateway
    // issues a reusable device token.
    deviceKey: process.env.OPENCLAW_DEVICE_KEY || '',
    // Optional alternative to deviceKey: persist/generate the identity in a file.
    deviceFile: process.env.OPENCLAW_DEVICE_FILE || '',
    // How often to retry the handshake while waiting for the device to be approved.
    pairingRetryMs: int(process.env.OPENCLAW_PAIRING_RETRY_MS, 10000),

    // Optional: pin a specific agent. If empty, the gateway uses its default agent.
    agentId: process.env.OPENCLAW_AGENT_ID || '',

    // Protocol version range advertised in the connect handshake.
    minProtocol: int(process.env.OPENCLAW_MIN_PROTOCOL, 3),
    maxProtocol: int(process.env.OPENCLAW_MAX_PROTOCOL, 3),

    // ── Timing / robustness knobs ────────────────────────────────────────────
    // How long to wait for the connect handshake to complete.
    connectTimeoutMs: int(process.env.OPENCLAW_CONNECT_TIMEOUT_MS, 15000),

    // Hard ceiling for a single chat turn. The agent can take a while before the
    // first token (large context injection), so this is generous by default.
    requestTimeoutMs: int(process.env.OPENCLAW_REQUEST_TIMEOUT_MS, 240000),

    // If the assistant stops streaming new text for this long after it has begun
    // replying, we treat the turn as complete. This is the fallback used when no
    // explicit "final" event is emitted by the gateway.
    idleCompletionMs: int(process.env.OPENCLAW_IDLE_COMPLETION_MS, 4000),

    // Auto-reconnect backoff bounds.
    reconnectMinMs: int(process.env.OPENCLAW_RECONNECT_MIN_MS, 1000),
    reconnectMaxMs: int(process.env.OPENCLAW_RECONNECT_MAX_MS, 30000),

    // Verbose frame logging for debugging the protocol.
    debug: bool(process.env.OPENCLAW_DEBUG, false),
  },
};

module.exports = config;
