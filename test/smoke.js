/**
 * Quick smoke test against a running backend.
 *
 *   node test/smoke.js "Hello, who are you?"
 *
 * Targets http://localhost:5000 by default; override with BASE_URL.
 */
const BASE = process.env.BASE_URL || 'http://localhost:5000';
const message = process.argv.slice(2).join(' ') || 'Hello! Give me a one-sentence intro.';

async function main() {
  // 1) health
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log('health:', health);

  // 2) non-streaming chat (first turn — no sessionKey)
  console.log(`\n→ sending: "${message}"`);
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`chat failed ${res.status}: ${JSON.stringify(data)}`);
  console.log('reply:', data.reply);
  console.log('sessionKey:', data.sessionKey);

  // 3) follow-up turn reusing the session (tests memory/continuity)
  const res2 = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What did I just ask you?', sessionKey: data.sessionKey }),
  });
  const data2 = await res2.json();
  console.log('\nfollow-up reply:', data2.reply);
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
