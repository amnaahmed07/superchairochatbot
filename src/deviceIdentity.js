const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Ed25519 device identity for remote gateway connections.
 *
 * Ported byte-for-byte from OpenClaw's own device-identity module so the
 * signatures the gateway verifies match exactly:
 *   - deviceId  = sha256(rawPublicKey).hex
 *   - publicKey = base64url(raw 32-byte ed25519 key)   (sent in connect.device.publicKey)
 *   - signature = base64url(ed25519 sign over the UTF-8 payload string)
 *
 * The connect signature payload (v3) the gateway reconstructs and verifies is:
 *   v3|deviceId|clientId|clientMode|role|scopes(comma)|signedAtMs|token|nonce|platform|deviceFamily
 */

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

// Lowercase ASCII only, matching normalizeDeviceMetadataForAuth in OpenClaw.
function normalizeMeta(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function buildDeviceAuthPayloadV3({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce,
  platform,
  deviceFamily,
}) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token ?? '',
    nonce,
    normalizeMeta(platform),
    normalizeMeta(deviceFamily),
  ].join('|');
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

/**
 * Load a persisted identity, or create one. The identity MUST be stable across
 * restarts/redeploys — otherwise every deploy creates a new device that needs
 * re-approval. On Railway, set OPENCLAW_DEVICE_KEY to the privateKeyPem (base64)
 * to keep it stable; otherwise it's stored at `filePath`.
 */
function loadOrCreateIdentity({ filePath, privateKeyB64 } = {}) {
  // 1) From env (recommended for Railway — survives ephemeral filesystem).
  if (privateKeyB64) {
    const privateKeyPem = Buffer.from(privateKeyB64, 'base64').toString('utf8');
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
  }

  // 2) From a file on disk.
  if (filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed?.privateKeyPem) {
          const privateKey = crypto.createPrivateKey(parsed.privateKeyPem);
          const publicKeyPem = crypto
            .createPublicKey(privateKey)
            .export({ type: 'spki', format: 'pem' });
          return {
            deviceId: fingerprintPublicKey(publicKeyPem),
            publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
      }
    } catch (_) {
      /* fall through to generate */
    }
    const identity = generateIdentity();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2),
        { mode: 0o600 }
      );
    } catch (_) {
      /* ignore persistence errors */
    }
    return identity;
  }

  // 3) Ephemeral (will need re-pairing on restart).
  return generateIdentity();
}

module.exports = {
  generateIdentity,
  loadOrCreateIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  buildDeviceAuthPayloadV3,
  fingerprintPublicKey,
};
