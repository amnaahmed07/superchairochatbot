const express = require('express');

/**
 * Chat routes. The backend is STATELESS with respect to conversations:
 * the frontend holds the `sessionKey` and sends it back on every turn. On the
 * first message it omits the key, the backend creates a session and returns it.
 *
 *   POST /api/chat          -> { reply, sessionKey }            (wait for full reply)
 *   POST /api/chat/stream   -> Server-Sent Events stream        (token-by-token)
 *   GET  /api/health        -> { status, gateway }
 */
module.exports = function chatRoutes(client) {
  const router = express.Router();

  // Resolve a session: use the one the client sent, or create a fresh one.
  async function resolveSession(sessionKey) {
    if (sessionKey) return sessionKey;
    const { sessionKey: created } = await client.createSession();
    return created;
  }

  // ── Non-streaming: simplest to integrate ───────────────────────────────────
  router.post('/chat', async (req, res) => {
    const { message, sessionKey: incoming } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!client.isReady()) {
      return res.status(503).json({ error: 'Chat service is connecting to the agent, try again shortly.' });
    }

    try {
      const sessionKey = await resolveSession(incoming);
      const { reply } = await client.chat({ sessionKey, message });
      return res.json({ reply, sessionKey });
    } catch (err) {
      req.log?.error?.('[chat] error:', err.message);
      const status = /not connected|closed|ECONNREFUSED|timed out/i.test(err.message) ? 503 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  // ── Streaming via Server-Sent Events ───────────────────────────────────────
  // Frontend: const es = new EventSource(...) won't work for POST; use fetch +
  // ReadableStream, or switch this to GET. We use POST + manual SSE framing.
  router.post('/chat/stream', async (req, res) => {
    const { message, sessionKey: incoming } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!client.isReady()) {
      return res.status(503).json({ error: 'Chat service is connecting to the agent, try again shortly.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let closed = false;

    // The agent can take ~90s to start a run before its first token. A stream
    // that stays completely silent that long gets buffered or dropped by proxies
    // in between, and trips the widget's idle watchdog. An SSE comment every 15s
    // keeps the turn visibly alive; comments carry no event, so parsers ignore it.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });

    try {
      const sessionKey = await resolveSession(incoming);
      send('session', { sessionKey });

      const { reply } = await client.chatStream({
        sessionKey,
        message,
        onDelta: (chunk) => {
          if (!closed) send('delta', { text: chunk });
        },
      });

      if (!closed) {
        send('done', { reply, sessionKey });
        res.end();
      }
    } catch (err) {
      req.log?.error?.('[chat/stream] error:', err.message);
      if (!closed) {
        send('error', { error: err.message });
        res.end();
      }
    } finally {
      clearInterval(heartbeat);
    }
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      gateway: client.isReady() ? 'connected' : 'disconnected',
    });
  });

  return router;
};
