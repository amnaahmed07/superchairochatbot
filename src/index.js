const express = require('express');
const cors = require('cors');
const config = require('./config');
const OpenClawClient = require('./openclawClient');
const chatRoutes = require('./routes/chat');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
const corsOptions =
  config.corsOrigins.includes('*')
    ? { origin: true }
    : { origin: config.corsOrigins };
app.use(cors(corsOptions));
app.use(express.json());

// tiny request logger handle for routes
app.use((req, _res, next) => {
  req.log = console;
  next();
});

// ── OpenClaw gateway client (single shared connection) ─────────────────────────
const client = new OpenClawClient(config, console);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ name: 'openclaw-chatbot-backend', status: 'running' });
});
app.use('/api', chatRoutes(client));

// ── Boot ─────────────────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  console.log(`HTTP server listening on port ${config.port}`);
});

// Connect to the gateway in the background. The server stays up and auto-reconnects;
// chat requests return 503 until the gateway is reachable.
client.start().catch((err) => {
  console.error('[startup] initial gateway connect failed:', err.message);
  console.error('[startup] will keep retrying in the background.');
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  client.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
