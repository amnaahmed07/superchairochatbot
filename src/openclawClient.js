const WebSocket = require('ws');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const deviceIdentity = require('./deviceIdentity');

/**
 * OpenClawClient
 * --------------
 * Maintains ONE persistent WebSocket connection to the OpenClaw gateway and
 * exposes a clean async API the rest of the app uses:
 *
 *   await client.start()                         // connect + authenticate (auto-reconnects)
 *   const { sessionKey } = await client.createSession()
 *   const reply = await client.chat({ sessionKey, message })          // full reply
 *   await client.chatStream({ sessionKey, message, onDelta, onDone }) // streaming reply
 *
 * Protocol (OpenClaw gateway WS, JSON text frames):
 *   - Requests:  { type:"req",  id, method, params }
 *   - Responses: { type:"res",  id, ok, payload | error }
 *   - Events:    { type:"event", event, payload, seq?, stateVersion? }
 *
 * Handshake: the gateway emits a "connect.challenge" event (nonce); we reply with
 * method "connect".
 *   - LOOPBACK (on the xCloud box): token-only auth → full operator scopes.
 *   - REMOTE (e.g. Railway): the token alone yields zero scopes, so we ALSO send a
 *     signed Ed25519 `device` block. A new device must be approved once in the
 *     Control UI ("pairing required"); after that the gateway returns a deviceToken
 *     we reuse on reconnect. Enabled by setting OPENCLAW_DEVICE_KEY.
 */
class OpenClawClient extends EventEmitter {
  constructor(config, logger = console) {
    super();
    this.cfg = config.openclaw;
    this.log = logger;

    this.ws = null;
    this.ready = false; // true once the connect handshake succeeds
    this.connecting = null; // Promise while a connect is in flight
    this.reconnectDelay = this.cfg.reconnectMinMs;
    this.shouldRun = false; // set by start(), cleared by stop()

    this.pending = new Map(); // request id -> { resolve, reject, timer }
    this.sessionHandlers = new Map(); // sessionKey -> Set<handler(event)>
    this.subscribedSessions = new Set();

    this.clientId = `chatbot-${crypto.randomBytes(4).toString('hex')}`;

    // Ed25519 device identity (only needed for REMOTE connections). If neither a
    // key nor a file is configured, we run in loopback/token-only mode.
    this.identity = null;
    if (this.cfg.deviceKey || this.cfg.deviceFile) {
      try {
        this.identity = deviceIdentity.loadOrCreateIdentity({
          privateKeyB64: this.cfg.deviceKey || undefined,
          filePath: this.cfg.deviceFile || undefined,
        });
        this.log.info?.(`[openclaw] device identity loaded: ${this.identity.deviceId}`);
      } catch (e) {
        this.log.error?.('[openclaw] failed to load device identity:', e.message);
      }
    }
    this.deviceToken = null; // returned by the gateway once paired; reused on reconnect
    this.waitingForPairing = false;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async start() {
    this.shouldRun = true;
    await this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  isReady() {
    return this.ready && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Resolves once the client is connected and authenticated. */
  async ensureReady() {
    if (this.isReady()) return;
    if (this.connecting) return this.connecting;
    return this._connect();
  }

  _connect() {
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      if (!this.cfg.token) {
        return reject(new Error('OPENCLAW_TOKEN is not set'));
      }

      this.log.info?.(`[openclaw] connecting to ${this.cfg.wsUrl}`);
      const headers = {};
      // Origin only matters when connecting through the public nginx endpoint.
      if (this.cfg.origin) headers.Origin = this.cfg.origin;
      // nginx HTTP Basic Auth gate in front of the gateway (if configured).
      if (this.cfg.basicUser || this.cfg.basicPass) {
        const creds = Buffer.from(
          `${this.cfg.basicUser}:${this.cfg.basicPass}`
        ).toString('base64');
        headers.Authorization = `Basic ${creds}`;
      }
      const ws = new WebSocket(this.cfg.wsUrl, {
        headers,
        handshakeTimeout: this.cfg.connectTimeoutMs,
      });
      this.ws = ws;
      this.ready = false;

      let challengeNonce = null;
      let settled = false;

      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        try {
          ws.terminate();
        } catch (_) {
          /* ignore */
        }
        reject(new Error('Timed out waiting for gateway connect handshake'));
      }, this.cfg.connectTimeoutMs);

      const sendConnect = () => {
        const id = this._newId();
        // Verified against the live gateway (OpenClaw 2026.4.25):
        //   client.id "cli", client.mode "backend", role "operator", protocol 3.
        const CLIENT_ID = 'cli';
        const MODE = 'backend';
        const ROLE = 'operator';
        const SCOPES = ['operator.read', 'operator.write'];
        const PLATFORM = process.platform;

        const auth = { token: this.cfg.token };
        if (this.deviceToken) auth.deviceToken = this.deviceToken;

        const params = {
          minProtocol: this.cfg.minProtocol,
          maxProtocol: this.cfg.maxProtocol,
          client: { id: CLIENT_ID, version: '1.0.0', platform: PLATFORM, mode: MODE },
          caps: [],
          role: ROLE,
          scopes: SCOPES,
          auth,
        };

        // REMOTE: attach a signed Ed25519 device block (requires the nonce).
        if (this.identity) {
          const signedAtMs = Date.now();
          const payload = deviceIdentity.buildDeviceAuthPayloadV3({
            deviceId: this.identity.deviceId,
            clientId: CLIENT_ID,
            clientMode: MODE,
            role: ROLE,
            scopes: SCOPES,
            signedAtMs,
            token: this.cfg.token,
            nonce: challengeNonce,
            platform: PLATFORM,
            deviceFamily: '',
          });
          params.device = {
            id: this.identity.deviceId,
            publicKey: deviceIdentity.publicKeyRawBase64UrlFromPem(this.identity.publicKeyPem),
            signature: deviceIdentity.signDevicePayload(this.identity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce: challengeNonce,
          };
        }

        // Register the pending connect response handler manually so we can
        // flip `ready` and resolve the outer promise on success.
        this.pending.set(id, {
          resolve: (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(handshakeTimer);
            this.ready = true;
            this.waitingForPairing = false;
            this.reconnectDelay = this.cfg.reconnectMinMs;
            this.connecting = null;
            // Persist the device token so future reconnects skip re-pairing.
            const dt = payload?.auth?.deviceToken;
            if (dt) {
              this.deviceToken = dt;
              this.log.info?.('[openclaw] received device token (paired)');
            }
            const grantedScopes = JSON.stringify(payload?.auth?.scopes ?? []);
            this.log.info?.(`[openclaw] gateway connected & authenticated; scopes=${grantedScopes}`);
            this.emit('ready');
            resolve(payload);
          },
          reject: (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(handshakeTimer);
            this.connecting = null;
            // "pairing required" is expected on first remote connect — handle it
            // specially: keep the process alive and retry until approved.
            const code = err.code || err.details?.code;
            if (code === 'NOT_PAIRED' || err.details?.code === 'PAIRING_REQUIRED') {
              this.waitingForPairing = true;
              this.log.warn?.(
                `\n[openclaw] ⏳ DEVICE PAIRING REQUIRED\n` +
                  `[openclaw]   Approve device ${this.identity?.deviceId} in your OpenClaw Control UI\n` +
                  `[openclaw]   (${this.cfg.origin || 'your dashboard'} → device pairing requests).\n` +
                  `[openclaw]   Retrying every ${Math.round(this.cfg.pairingRetryMs / 1000)}s until approved...\n`
              );
            }
            try {
              ws.close();
            } catch (_) {
              /* ignore */
            }
            reject(err);
          },
          timer: null,
        });
        this._sendRaw({ type: 'req', id, method: 'connect', params });
      };

      ws.on('open', () => {
        this.log.info?.('[openclaw] socket open, awaiting connect challenge');
        // A signed device handshake REQUIRES the challenge nonce, so when we have
        // an identity we always wait for connect.challenge. For loopback/token-only
        // we still prefer the challenge but fall back to a timer if none arrives.
        let t = null;
        if (!this.identity) t = setTimeout(() => sendConnect(), 300);
        this._pendingConnectTrigger = () => {
          if (t) clearTimeout(t);
          if (!settled && this.pending.size === 0) sendConnect();
        };
        this._setChallengeNonce = (nonce) => {
          challengeNonce = nonce;
        };
      });

      ws.on('message', (data) => this._onFrame(data));

      ws.on('error', (err) => {
        this.log.error?.('[openclaw] socket error:', err.message);
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          this.connecting = null;
          reject(err);
        }
      });

      ws.on('close', (code, reason) => {
        this.ready = false;
        this.log.warn?.(
          `[openclaw] socket closed (${code}) ${reason ? reason.toString() : ''}`
        );
        // Fail any in-flight requests so callers don't hang.
        for (const [id, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error('Gateway connection closed'));
          this.pending.delete(id);
        }
        this.subscribedSessions.clear();
        this.emit('disconnected');
        if (this.shouldRun) this._scheduleReconnect();
      });
    });

    return this.connecting;
  }

  _scheduleReconnect() {
    // While waiting for a human to approve the device, poll at a steady, calm
    // interval instead of exponential backoff.
    const delay = this.waitingForPairing ? this.cfg.pairingRetryMs : this.reconnectDelay;
    if (!this.waitingForPairing) {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.cfg.reconnectMaxMs);
    }
    this.log.info?.(`[openclaw] reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (!this.shouldRun) return;
      this._connect().catch((e) =>
        this.log.error?.('[openclaw] reconnect failed:', e.message)
      );
    }, delay);
  }

  // ── frame handling ─────────────────────────────────────────────────────────
  _onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch (_) {
      return; // ignore non-JSON frames
    }
    if (this.cfg.debug) this.log.info?.('[openclaw] <<', JSON.stringify(frame));

    if (frame.type === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (p.timer) clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(this._toError(frame.error));
      return;
    }

    if (frame.type === 'event') {
      // Capture the auth challenge nonce (if the gateway uses one).
      if (frame.event === 'connect.challenge') {
        const nonce = frame.payload && frame.payload.nonce;
        if (this._setChallengeNonce) this._setChallengeNonce(nonce);
        if (this._pendingConnectTrigger) this._pendingConnectTrigger();
        return;
      }
      this._routeSessionEvent(frame);
      this.emit('event', frame);
    }
  }

  _routeSessionEvent(frame) {
    const sessionKey = frame.payload && frame.payload.sessionKey;
    if (!sessionKey) return;
    const handlers = this.sessionHandlers.get(sessionKey);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(frame);
      } catch (e) {
        this.log.error?.('[openclaw] session handler error:', e.message);
      }
    }
  }

  // ── request helper ──────────────────────────────────────────────────────────
  _request(method, params, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isReady()) {
        return reject(new Error('Gateway not connected'));
      }
      const id = this._newId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request "${method}" timed out`));
      }, timeoutMs || this.cfg.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this._sendRaw({ type: 'req', id, method, params });
    });
  }

  _sendRaw(frame) {
    if (this.cfg.debug) this.log.info?.('[openclaw] >>', JSON.stringify(frame));
    this.ws.send(JSON.stringify(frame));
  }

  _newId() {
    return crypto.randomUUID();
  }

  _toError(err) {
    if (!err) return new Error('Unknown gateway error');
    const e = new Error(err.message || err.code || 'Gateway error');
    e.code = err.code;
    e.details = err.details;
    return e;
  }

  // ── session + chat API ──────────────────────────────────────────────────────

  /** Create a fresh conversation session. Returns { sessionKey }. */
  async createSession() {
    await this.ensureReady();
    const params = {};
    if (this.cfg.agentId) params.agentId = this.cfg.agentId;
    const payload = await this._request('sessions.create', params);
    const sessionKey =
      payload.sessionKey || payload.key || payload.id || payload.session?.key;
    if (!sessionKey) {
      throw new Error(
        `sessions.create did not return a session key: ${JSON.stringify(payload)}`
      );
    }
    return { sessionKey, raw: payload };
  }

  async _ensureSubscribed(sessionKey) {
    if (this.subscribedSessions.has(sessionKey)) return;
    // Schema requires { key }, not { sessionKey }.
    await this._request('sessions.messages.subscribe', { key: sessionKey });
    this.subscribedSessions.add(sessionKey);
  }

  _addSessionHandler(sessionKey, handler) {
    if (!this.sessionHandlers.has(sessionKey)) {
      this.sessionHandlers.set(sessionKey, new Set());
    }
    this.sessionHandlers.get(sessionKey).add(handler);
    return () => {
      const set = this.sessionHandlers.get(sessionKey);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.sessionHandlers.delete(sessionKey);
      }
    };
  }

  /**
   * Send a message and stream the assistant's reply.
   *
   * @param {object}   opts
   * @param {string}   opts.sessionKey
   * @param {string}   opts.message
   * @param {function} [opts.onDelta]  called with each incremental text chunk
   * @returns {Promise<{reply:string, sessionKey:string}>}  resolves on completion
   */
  async chatStream({ sessionKey, message, onDelta }) {
    if (!sessionKey) throw new Error('sessionKey is required');
    if (!message || !message.trim()) throw new Error('message is required');

    await this.ensureReady();
    await this._ensureSubscribed(sessionKey);

    return new Promise((resolve, reject) => {
      let snapshot = ''; // best-known cumulative assistant text
      let delta = ''; // fallback accumulation of deltas
      let started = false;
      let finished = false;
      let idleTimer = null;

      const finish = (err) => {
        if (finished) return;
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        removeHandler();
        if (err) return reject(err);
        resolve({ reply: (snapshot || delta).trim(), sessionKey });
      };

      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), this.cfg.idleCompletionMs);
      };

      const hardTimer = setTimeout(
        () => finish(new Error('Assistant reply timed out')),
        this.cfg.requestTimeoutMs
      );

      // Extract plain text from an OpenClaw message object. Assistant content is
      // an array of parts: [{type:"text",text:"..."}, {type:"thinking",...}]. We
      // keep only the text parts. Also tolerates string content / older shapes.
      const extractText = (m) => {
        if (!m) return null;
        if (typeof m === 'string') return m;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
        }
        if (typeof m.content === 'string') return m.content;
        if (typeof m.text === 'string') return m.text;
        return null;
      };

      // Each "chat" delta carries the FULL assistant text so far (cumulative),
      // so we replace the snapshot rather than append, and emit only the new tail.
      const applySnapshot = (text) => {
        if (text == null) return;
        started = true;
        if (onDelta) {
          if (text.startsWith(snapshot)) {
            if (text.length > snapshot.length) onDelta(text.slice(snapshot.length));
          } else {
            onDelta(text); // non-cumulative fallback
          }
        }
        snapshot = text;
        bumpIdle();
      };

      const handler = (frame) => {
        const { event, payload } = frame;

        // Primary streaming channel: the "chat" event with a state machine.
        if (event === 'chat') {
          const role = payload.message?.role;
          if (role && role !== 'assistant') return;
          applySnapshot(extractText(payload.message));
          if (payload.state === 'final') return finish();
          if (payload.state === 'error' || payload.state === 'aborted') {
            return finish(new Error(payload.errorMessage || `chat ${payload.state}`));
          }
          return;
        }

        // Fallback transcript channel (used by older builds, and carries the
        // final assistant message). Only treat assistant messages as the reply.
        if (event === 'session.message' || event === 'chat.message') {
          const role = payload.message?.role || payload.role;
          if (role !== 'assistant') return; // ignore the user echo
          const text = extractText(payload.message);
          if (text != null && text.length >= snapshot.length) applySnapshot(text);
          return;
        }
      };

      const removeHandler = this._addSessionHandler(sessionKey, handler);

      // Fire the message. The res only confirms acceptance; the reply arrives via
      // events. Schema: { sessionKey, message, idempotencyKey } — additionalProperties
      // is false, so no agentId here (the session is already bound to its agent).
      this._request('chat.send', {
        sessionKey,
        message,
        idempotencyKey: this._newId(),
      }).catch((err) => finish(err));

      // Safety net: if nothing ever streams back, the hard timeout above fires.
      // Once anything starts, the idle timer takes over.
      void started;
    });
  }

  /** Send a message and resolve with the complete reply (no streaming). */
  async chat({ sessionKey, message }) {
    return this.chatStream({ sessionKey, message });
  }
}

module.exports = OpenClawClient;
