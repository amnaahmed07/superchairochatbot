/**
 * Protocol discovery — RUN THIS ON THE xCloud SERVER (loopback).
 *
 *   OPENCLAW_TOKEN=... node scripts/discover.js "Say PONG"
 *
 * It connects to the gateway over loopback, creates a session, sends one
 * message, and prints EVERY raw frame for 60s. Use it to confirm the exact
 * shape of the assistant reply events (chat / session.message) so the parser in
 * src/openclawClient.js can be tuned if your gateway build differs.
 *
 * Paste the output back and the reply parser can be adjusted to match exactly.
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../src/config');

const URL = config.openclaw.wsUrl;
const TOKEN = config.openclaw.token;
const message = process.argv.slice(2).join(' ') || 'Reply with exactly: PONG';

if (!TOKEN) {
  console.error('Set OPENCLAW_TOKEN (or put it in .env).');
  process.exit(1);
}

const headers = {};
if (config.openclaw.origin) headers.Origin = config.openclaw.origin;
if (config.openclaw.basicUser || config.openclaw.basicPass) {
  headers.Authorization =
    'Basic ' +
    Buffer.from(`${config.openclaw.basicUser}:${config.openclaw.basicPass}`).toString('base64');
}

console.log(`[discover] connecting to ${URL}`);
const ws = new WebSocket(URL, { headers, handshakeTimeout: 15000 });

function req(method, params) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return id;
}

let sessionKey = null;

ws.on('open', () => console.log('[discover] socket open'));

ws.on('message', (data) => {
  let f;
  try {
    f = JSON.parse(data.toString());
  } catch (_) {
    console.log('[raw non-json]', data.toString().slice(0, 200));
    return;
  }

  if (f.event === 'connect.challenge') {
    req('connect', {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'backend' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: TOKEN },
    });
    return;
  }

  if (f.type === 'res') {
    if (f.payload && f.payload.type === 'hello-ok') {
      console.log('[discover] authenticated; scopes =', JSON.stringify(f.payload.auth?.scopes));
      console.log('[discover] defaultAgentId =', f.payload.snapshot?.sessionDefaults?.defaultAgentId);
      console.log('[discover] creating session...');
      req('sessions.create', {});
      return;
    }
    if (!f.ok) {
      console.log('[RES ERROR]', JSON.stringify(f.error));
      return;
    }
    // sessions.create response
    if (!sessionKey && (f.payload?.sessionKey || f.payload?.key)) {
      sessionKey = f.payload.sessionKey || f.payload.key;
      console.log('[discover] sessionKey =', sessionKey);
      console.log('[discover] full create payload:', JSON.stringify(f.payload));
      req('sessions.messages.subscribe', { sessionKey });
      setTimeout(() => {
        console.log(`[discover] sending: "${message}"`);
        req('chat.send', { sessionKey, text: message, idempotencyKey: crypto.randomUUID() });
      }, 500);
      return;
    }
    console.log('[RES ok]', JSON.stringify(f.payload).slice(0, 400));
    return;
  }

  if (f.type === 'event') {
    // The interesting ones for replies:
    if (['chat', 'session.message', 'session.tool', 'agent'].includes(f.event)) {
      console.log(`\n[EVENT ${f.event}]`, JSON.stringify(f.payload));
    }
  }
});

ws.on('error', (e) => console.error('[discover] error:', e.message));
ws.on('close', (c) => console.log('[discover] closed', c));

setTimeout(() => {
  console.log('\n[discover] done.');
  ws.close();
  process.exit(0);
}, 60000);
