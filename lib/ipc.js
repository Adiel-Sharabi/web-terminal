// lib/ipc.js — framing + pipe server/client helpers for the hot-reload IPC
//
// Frame layout:
//   [4 bytes LE length][1 byte type][payload bytes]
//
// Types:
//   0x00  JSON control (payload = utf8 JSON)
//   0x01  PTY_OUT      (payload = 16-byte UUID bytes + raw PTY output bytes)
//   0x02  PTY_IN       (payload = 16-byte UUID bytes + raw user input bytes)
//   0x03  HANDSHAKE    (payload = shared-secret token bytes; issue #18)
//   0x04  HANDSHAKE_ACK(payload = empty; issue #18)

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');

const TYPE_JSON = 0x00;
const TYPE_PTY_OUT = 0x01;
const TYPE_PTY_IN = 0x02;
const TYPE_HANDSHAKE = 0x03;
const TYPE_HANDSHAKE_ACK = 0x04;

// Max frame body size — 16 MB. Guards against malformed length headers.
const MAX_BODY = 16 * 1024 * 1024;

function uuidToBytes(id) {
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function encodeFrame(type, payload) {
  const len = 1 + payload.length;
  const out = Buffer.allocUnsafe(4 + len);
  out.writeUInt32LE(len, 0);
  out[4] = type;
  payload.copy(out, 5);
  return out;
}

function encodeJson(obj) {
  return encodeFrame(TYPE_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function encodePtyOut(sessionId, data) {
  const uuid = uuidToBytes(sessionId);
  const payload = Buffer.concat([uuid, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  return encodeFrame(TYPE_PTY_OUT, payload);
}

function encodePtyIn(sessionId, data) {
  const uuid = uuidToBytes(sessionId);
  const payload = Buffer.concat([uuid, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  return encodeFrame(TYPE_PTY_IN, payload);
}

// Issue #11: optimized variants that skip the per-call uuid hex parse +
// allocation. Callers compute `idBytes = uuidToBytes(id)` once (typically at
// session create / attach) and reuse the same 16-byte Buffer for every
// subsequent PTY frame on that session. Hot path: encodePtyOutFromBytes is
// called once per PTY output chunk in pty-worker.js.
//
// Defensive: validate the buffer shape. A buggy caller that passes a
// wrong-length buffer would silently corrupt the wire format (subsequent
// frames would be misaligned on the decoder side, producing bogus sessionIds
// and garbled data). Throwing TypeError makes the bug loud and local.
function _assertIdBytes(idBytes) {
  if (!Buffer.isBuffer(idBytes) || idBytes.length !== 16) {
    throw new TypeError('idBytes must be a 16-byte Buffer');
  }
}

function encodePtyOutFromBytes(idBytes, data) {
  _assertIdBytes(idBytes);
  const payload = Buffer.concat([idBytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  return encodeFrame(TYPE_PTY_OUT, payload);
}

function encodePtyInFromBytes(idBytes, data) {
  _assertIdBytes(idBytes);
  const payload = Buffer.concat([idBytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  return encodeFrame(TYPE_PTY_IN, payload);
}

function parsePtyFrame(frame) {
  const sessionId = bytesToUuid(frame.payload.slice(0, 16));
  const data = frame.payload.slice(16);
  return { sessionId, data };
}

// FrameDecoder — accumulates bytes, emits 'frame' events once complete frames are available.
//
// Uses a chunk-list model to avoid the O(n²) Buffer.concat behavior that the
// naive `this._buf = Buffer.concat([this._buf, chunk])` pattern causes for
// multi-MB frames split across many small chunks (issue #14). Incoming chunks
// are appended to `_chunks` in O(1). We concat only when we actually need to
// produce a contiguous region (the 4-byte header if it spans chunks, and the
// payload when the frame is complete) — and we concat exactly those bytes, not
// the entire pending buffer.
class FrameDecoder extends EventEmitter {
  constructor() {
    super();
    this._chunks = [];       // Buffer[] — pending chunks, head partially consumed
    this._totalLen = 0;      // total unread bytes across _chunks
    this._consumed = 0;      // bytes already consumed from _chunks[0]
  }

  // Returns a Buffer with `length` bytes starting at `offset` into the
  // logical stream of pending bytes. If the requested range fits inside a
  // single chunk we return a slice (no copy). If it spans chunks we copy
  // exactly those bytes into a fresh Buffer. Returns null if not enough
  // data is buffered yet.
  _readAt(offset, length) {
    if (offset + length > this._totalLen) return null;
    // Walk chunks, accounting for the already-consumed prefix in chunks[0].
    let absStart = offset + this._consumed;
    let i = 0;
    while (i < this._chunks.length && absStart >= this._chunks[i].length) {
      absStart -= this._chunks[i].length;
      i++;
    }
    // `absStart` is now the byte offset within _chunks[i] of the first byte.
    const first = this._chunks[i];
    if (absStart + length <= first.length) {
      // Fits entirely inside one chunk — no copy.
      return first.slice(absStart, absStart + length);
    }
    // Spans chunks — copy exactly `length` bytes.
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    // First (partial) chunk
    let take = first.length - absStart;
    first.copy(out, 0, absStart, absStart + take);
    written = take;
    i++;
    while (written < length) {
      const c = this._chunks[i++];
      take = Math.min(c.length, length - written);
      c.copy(out, written, 0, take);
      written += take;
    }
    return out;
  }

  // Advance the read cursor by `length` bytes, dropping fully-consumed chunks.
  _consume(length) {
    this._totalLen -= length;
    let remaining = length;
    while (remaining > 0 && this._chunks.length) {
      const head = this._chunks[0];
      const avail = head.length - this._consumed;
      if (remaining < avail) {
        this._consumed += remaining;
        remaining = 0;
      } else {
        remaining -= avail;
        this._chunks.shift();
        this._consumed = 0;
      }
    }
  }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    this._chunks.push(chunk);
    this._totalLen += chunk.length;
    this._parseLoop();
  }

  _parseLoop() {
    while (this._totalLen >= 4) {
      const header = this._readAt(0, 4);
      // header is non-null because _totalLen >= 4
      const len = header.readUInt32LE(0);
      if (len < 1 || len > MAX_BODY) {
        // Malformed / hostile peer. Drop state and surface an error.
        this._chunks = [];
        this._totalLen = 0;
        this._consumed = 0;
        this.emit('error', new Error(`Invalid frame length: ${len}`));
        return;
      }
      if (this._totalLen < 4 + len) break; // wait for more bytes
      // Read type byte + payload. `len` is the body size = 1 (type) + payload.
      const body = this._readAt(4, len);
      const type = body[0];
      const payload = body.slice(1);
      this.emit('frame', { type, payload });
      this._consume(4 + len);
    }
  }
}

// Issue #18 — defense-in-depth authentication on the worker IPC pipe.
//
// Threat model: on multi-user hosts and shared-tmp containers, a local
// attacker can connect to the named pipe / unix socket and issue RPCs to the
// worker (killSession, getScrollback — which may contain terminal secrets,
// createSession with attacker-supplied ids, etc). Three layers:
//
//   1. Unix: chmod 0600 on the socket file — only the owning uid can connect.
//   2. Windows: Node's default DACL on `\\.\pipe\*` grants Everyone Read and
//      ANONYMOUS LOGON Read. Write is NOT in the default DACL for Everyone,
//      so a non-admin attacker cannot issue RPCs, but they can read any
//      unsolicited frames the worker sends (currently none pre-handshake, but
//      the handshake closes the gap anyway). A restrictive DACL would require
//      native P/Invoke; skipped — the handshake covers the gap.
//   3. App-level handshake (this module): the client MUST send a valid
//      HANDSHAKE frame as the very first frame; the server compares it with
//      its configured token via crypto.timingSafeEqual and closes the
//      connection on mismatch or any non-handshake first frame. Mismatched
//      clients see no RPC responses, no events, and no ack — just an EOF.
//
// The token is a 32-byte random buffer, typically generated once by monitor.js
// and passed to both children via WT_IPC_TOKEN (base64). When no token is
// supplied (neither option nor env var), the handshake layer is SKIPPED — this
// preserves backwards-compat with tests that construct bare Ipc{Server,Client}
// pairs over fresh ephemeral pipes, and with development setups that haven't
// rolled out the token yet. Production monitor.js always sets the token.
const ENV_TOKEN_VAR = 'WT_IPC_TOKEN';
// Handshake frames are bounded: a well-formed token is 32 bytes. A runaway
// client that sends a huge first frame would be flagged as an auth failure
// anyway via timingSafeEqual, but we cap the handshake payload so the server
// can't be made to allocate a big buffer before rejecting.
const MAX_HANDSHAKE_PAYLOAD = 1024;
// Handshake deadline — a connected peer has this long to send a valid
// handshake before we drop them. Prevents a slowloris-style hold.
const HANDSHAKE_TIMEOUT_MS = 5000;

function _resolveAuthToken(opt) {
  if (opt && Object.prototype.hasOwnProperty.call(opt, 'authToken')) {
    return opt.authToken == null ? null : _normalizeToken(opt.authToken);
  }
  const env = process.env[ENV_TOKEN_VAR];
  if (env && env.length > 0) return _normalizeToken(env);
  return null;
}

function _normalizeToken(tok) {
  if (Buffer.isBuffer(tok)) return tok;
  // String form — accept base64. Decode to bytes. We don't require any
  // particular length here; comparison uses timingSafeEqual which handles
  // arbitrary equal-length buffers.
  const s = String(tok);
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 0 && s.length > 0) {
      // Base64 decoded to empty (all non-base64 chars). Treat as raw utf8
      // instead, so tests / callers passing a plain string still work.
      return Buffer.from(s, 'utf8');
    }
    return buf;
  } catch {
    return Buffer.from(s, 'utf8');
  }
}

// Constant-time equality — a wrapper around timingSafeEqual that handles
// unequal-length inputs safely (timingSafeEqual throws on length mismatch).
function _tokenEquals(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  if (a.length === 0) return false; // both empty shouldn't match
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Server: named-pipe (or unix-socket) listener. Accepts ONE connection at a time.
// Additional connections are immediately closed.
class IpcServer extends EventEmitter {
  constructor(pipePath, opts = {}) {
    super();
    this._pipePath = pipePath;
    this._currentConn = null;
    this._closed = false;
    this._authToken = _resolveAuthToken(opts);
    this._server = net.createServer((sock) => this._onSocket(sock));
    this._server.on('error', (err) => this.emit('error', err));

    // On unix-ish, remove stale socket file
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(pipePath); } catch {}
    }
    this._listenPromise = new Promise((resolve, reject) => {
      this._server.once('listening', () => {
        // Issue #18 layer 1: restrict socket ACL on unix so only the owner
        // can connect. On Windows the default DACL grants Everyone Read (see
        // module-level comment); we rely on the handshake for defense there.
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(pipePath, 0o600);
          } catch (err) {
            // Log, don't fail listen — the handshake still gates access.
            try { this.emit('warning', new Error(`chmod 0600 failed on ${pipePath}: ${err.message}`)); } catch {}
          }
        }
        resolve();
      });
      this._server.once('error', reject);
      this._server.listen(pipePath);
    });
  }
  listening() { return this._listenPromise; }
  _onSocket(sock) {
    if (this._currentConn && !this._currentConn._closed) {
      // Reject — one client at a time
      try { sock.destroy(); } catch {}
      return;
    }
    // Issue #18: intercept the first frame and validate it's a handshake with
    // the matching token before we expose the connection to application code.
    // If no token is configured, pass through (legacy / test mode).
    if (!this._authToken) {
      const conn = new IpcConnection(sock);
      this._currentConn = conn;
      conn.on('close', () => {
        if (this._currentConn === conn) this._currentConn = null;
      });
      this.emit('connection', conn);
      return;
    }
    this._gateWithHandshake(sock);
  }
  _gateWithHandshake(sock) {
    const decoder = new FrameDecoder();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      try { this.emit('authFail', new Error('handshake timeout')); } catch {}
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
    };

    const onData = (chunk) => {
      if (settled) return;
      try { decoder.push(chunk); } catch { /* fall through via decoder 'error' */ }
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    decoder.on('frame', (frame) => {
      if (settled) return;
      if (frame.type !== TYPE_HANDSHAKE || frame.payload.length > MAX_HANDSHAKE_PAYLOAD) {
        settled = true;
        cleanup();
        try { sock.destroy(); } catch {}
        try { this.emit('authFail', new Error('first frame was not a valid handshake')); } catch {}
        return;
      }
      if (!_tokenEquals(frame.payload, this._authToken)) {
        settled = true;
        cleanup();
        try { sock.destroy(); } catch {}
        try { this.emit('authFail', new Error('handshake token mismatch')); } catch {}
        return;
      }
      // Accept: hand the socket (with the already-consumed handshake byte
      // accounted for in `decoder`) to a real IpcConnection. We pass the
      // existing decoder so any bytes that arrived in the same TCP chunk
      // after the handshake aren't lost.
      settled = true;
      cleanup();
      // Send ACK before handing off, so the client can await a round-trip if
      // it wants. This is optional; clients that don't read the ack still work.
      try {
        sock.write(encodeFrame(TYPE_HANDSHAKE_ACK, Buffer.alloc(0)));
      } catch { /* next write will fail; let IpcConnection handle it */ }
      const conn = new IpcConnection(sock, { _preDecoder: decoder });
      this._currentConn = conn;
      conn.on('close', () => {
        if (this._currentConn === conn) this._currentConn = null;
      });
      this.emit('connection', conn);
    });
    decoder.on('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { sock.destroy(); } catch {}
      try { this.emit('authFail', new Error('malformed handshake frame')); } catch {}
    });

    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  }
  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    if (this._currentConn) {
      try { this._currentConn.close(); } catch {}
    }
    return new Promise((resolve) => this._server.close(() => resolve()));
  }
}

// Issue #15: hard cap on in-flight bytes buffered in user-space for a single
// IPC connection. Node's net.Socket will buffer unbounded pending writes when
// the peer is not draining, which can exhaust the worker's memory and kill
// every PTY. If a connection is this far behind we destroy it — scrollback
// will cover the gap when the client reconnects/re-attaches.
//
// Default: 50 MB. Configurable via WT_IPC_MAX_INFLIGHT (bytes). Values that
// aren't finite positive numbers fall back to the default; this prevents a
// malformed env from accidentally disabling the safety net.
const DEFAULT_IPC_MAX_INFLIGHT = 50 * 1024 * 1024;
function _resolveMaxInflight() {
  const raw = process.env.WT_IPC_MAX_INFLIGHT;
  if (raw == null || raw === '') return DEFAULT_IPC_MAX_INFLIGHT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IPC_MAX_INFLIGHT;
  return Math.floor(n);
}

// IpcConnection wraps a net.Socket with frame decoding and send helper.
//
// Backpressure contract (Issue #15):
//   - send(buf) returns the boolean result of the underlying socket.write:
//     true  = the chunk was flushed to the kernel (no user-space buffering)
//     false = the chunk was buffered in user-space; the caller should stop
//             sending optional data until the 'drain' event fires.
//   - 'drain' event is emitted when the underlying socket drains (i.e. its
//     user-space buffer empties). Callers that dropped frames on backpressure
//     can resume sending on this signal.
//   - Exposes writeQueueBytes (getter) reflecting socket.writableLength, so
//     callers can see queue depth.
//   - Hard limit: if writableLength exceeds _maxInflight, the connection is
//     destroyed and 'overflow' is emitted before 'close'. This is the safety
//     net against runaway slow consumers.
class IpcConnection extends EventEmitter {
  constructor(sock, opts = {}) {
    super();
    this._sock = sock;
    // Issue #18: IpcServer's handshake gate consumes the first frame via its
    // own decoder; it hands the decoder off here so any bytes received in the
    // same chunk after the handshake aren't lost. Pre-buffered frames in that
    // decoder — if any — are flushed out synchronously on next tick via
    // 'frame' events, preserving ordering.
    this._decoder = opts._preDecoder || new FrameDecoder();
    this._closed = false;
    // Resolve once per connection — env changes after construction don't
    // retroactively alter the threshold, which matches the rest of the
    // worker's config handling (env snapshotted at process start).
    this._maxInflight = opts.maxInflight != null ? opts.maxInflight : _resolveMaxInflight();
    sock.on('data', (chunk) => this._decoder.push(chunk));
    sock.on('drain', () => {
      // 'drain' fires when the socket's user-space buffer empties after a
      // write returned false. Re-emit for callers so they can clear their
      // per-connection isDraining flag and resume sending.
      this.emit('drain');
    });
    sock.on('close', () => {
      if (this._closed) return;
      this._closed = true;
      this.emit('close');
    });
    sock.on('error', (err) => this.emit('error', err));
    this._decoder.on('frame', (f) => this.emit('frame', f));
    this._decoder.on('error', (err) => this.emit('error', err));
  }
  // Number of bytes currently buffered in user-space for this socket. On
  // platforms where socket.writableLength is unavailable (shouldn't happen on
  // supported Node versions), returns 0 — the hard-limit guard then cannot
  // trigger, but the boolean return from socket.write still drives the
  // is-draining signal, which is the primary backpressure mechanism.
  get writeQueueBytes() {
    const sock = this._sock;
    if (!sock) return 0;
    // Node exposes writableLength on net.Socket (Writable stream). Fall back
    // to 0 if the property is missing (defensive — not expected).
    return typeof sock.writableLength === 'number' ? sock.writableLength : 0;
  }
  send(buf) {
    if (this._closed || !this._sock) return false;
    // Hard limit: if this write would push us past the threshold, or we're
    // already past it (shouldn't normally happen — we close at the boundary),
    // destroy the connection. The caller treats this the same as any other
    // send returning false; subsequent sends short-circuit via _closed.
    const queued = this.writeQueueBytes;
    if (queued + buf.length > this._maxInflight) {
      const err = new Error(
        `IPC write queue exceeded ${this._maxInflight} bytes (queued=${queued}, frame=${buf.length}) — destroying connection`
      );
      this.emit('overflow', err);
      this.close();
      return false;
    }
    return this._sock.write(buf);
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    try { this._sock.destroy(); } catch {}
  }
}

// IpcClient — connects to a pipe, optionally retries on disconnect.
class IpcClient extends EventEmitter {
  constructor(pipePath, opts = {}) {
    super();
    this._pipePath = pipePath;
    this._retry = !!opts.retry;
    this._retryDelayMs = opts.retryDelayMs || 500;
    this._closed = false;
    this._sock = null;
    this._decoder = null;
    this._connectPromise = null;
    // Issue #18: token for the handshake. Same resolution rule as the server:
    // explicit option > WT_IPC_TOKEN env var > null (no handshake). If set, we
    // transmit the handshake as the very first frame on every (re)connect
    // before any app-level frame; nothing else about the wire protocol changes.
    this._authToken = _resolveAuthToken(opts);
    this._connect();
  }
  _connect() {
    const sock = net.createConnection(this._pipePath);
    this._sock = sock;
    this._decoder = new FrameDecoder();

    const isInitial = !this._connectPromise;
    if (isInitial) {
      this._connectPromise = new Promise((resolve, reject) => {
        this._resolveInitial = resolve;
        this._rejectInitial = reject;
      });
    }

    sock.once('connect', () => {
      sock._wtConnected = true;
      // Issue #18: send handshake as the very first frame. We send it
      // unconditionally when the token is configured — the server with no
      // token configured ignores the frame type, but that configuration is
      // only used in tests and shares a symmetric disabled/enabled state.
      if (this._authToken) {
        try {
          sock.write(encodeFrame(TYPE_HANDSHAKE, this._authToken));
        } catch { /* write will fail downstream; close handler recovers */ }
      }
      this.emit('connected');
      if (this._resolveInitial) {
        this._resolveInitial();
        this._resolveInitial = null;
        this._rejectInitial = null;
      }
    });

    sock.on('data', (chunk) => this._decoder.push(chunk));
    sock.on('drain', () => this.emit('drain'));
    sock.on('close', () => {
      this.emit('close');
      if (this._retry && !this._closed) {
        setTimeout(() => { if (!this._closed) this._connect(); }, this._retryDelayMs);
      }
    });
    sock.on('error', (err) => {
      if (this._retry) return; // retry path handles reconnect via 'close'
      if (!sock._wtConnected && this._rejectInitial) {
        const reject = this._rejectInitial;
        this._rejectInitial = null;
        this._resolveInitial = null;
        reject(err);
      } else {
        this.emit('error', err);
      }
    });
    this._decoder.on('frame', (f) => {
      // Issue #18: the server sends an ACK after a successful handshake.
      // Swallow it so application code never sees the 0x04 frame type.
      if (f.type === TYPE_HANDSHAKE_ACK) return;
      this.emit('frame', f);
    });
    this._decoder.on('error', (err) => this.emit('error', err));
  }
  connected() { return this._connectPromise; }
  // Exposed for symmetry with IpcConnection (Issue #15). Client-side backpressure
  // matters less in practice (server.js only pushes PTY_IN frames and RPC, both
  // small) but the symmetry keeps callers honest and simplifies testing.
  get writeQueueBytes() {
    const sock = this._sock;
    if (!sock) return 0;
    return typeof sock.writableLength === 'number' ? sock.writableLength : 0;
  }
  send(buf) {
    if (this._closed || !this._sock) return false;
    return this._sock.write(buf);
  }
  close() {
    this._closed = true;
    try { if (this._sock) this._sock.destroy(); } catch {}
    return Promise.resolve();
  }
}

function createServer(pipePath, opts) {
  return new IpcServer(pipePath, opts);
}

function createClient(pipePath, opts) {
  return new IpcClient(pipePath, opts);
}

// Generate a random 32-byte handshake token, base64-encoded for env var
// transport. Monitor.js uses this at startup and hands it to both children
// via WT_IPC_TOKEN.
function generateToken() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = {
  TYPE_JSON, TYPE_PTY_OUT, TYPE_PTY_IN, TYPE_HANDSHAKE, TYPE_HANDSHAKE_ACK,
  MAX_BODY,
  encodeFrame, encodeJson, encodePtyOut, encodePtyIn,
  encodePtyOutFromBytes, encodePtyInFromBytes,
  uuidToBytes, bytesToUuid,
  parsePtyFrame,
  FrameDecoder,
  IpcServer, IpcClient, IpcConnection,
  createServer, createClient,
  generateToken,
  ENV_TOKEN_VAR,
};
