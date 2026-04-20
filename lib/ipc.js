// lib/ipc.js — framing + pipe server/client helpers for the hot-reload IPC
//
// Frame layout:
//   [4 bytes LE length][1 byte type][payload bytes]
//
// Types:
//   0x00  JSON control (payload = utf8 JSON)
//   0x01  PTY_OUT      (payload = 16-byte UUID bytes + raw PTY output bytes)
//   0x02  PTY_IN       (payload = 16-byte UUID bytes + raw user input bytes)

const net = require('net');
const { EventEmitter } = require('events');
const fs = require('fs');

const TYPE_JSON = 0x00;
const TYPE_PTY_OUT = 0x01;
const TYPE_PTY_IN = 0x02;

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

// Server: named-pipe (or unix-socket) listener. Accepts ONE connection at a time.
// Additional connections are immediately closed.
class IpcServer extends EventEmitter {
  constructor(pipePath) {
    super();
    this._pipePath = pipePath;
    this._currentConn = null;
    this._closed = false;
    this._server = net.createServer((sock) => this._onSocket(sock));
    this._server.on('error', (err) => this.emit('error', err));

    // On unix-ish, remove stale socket file
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(pipePath); } catch {}
    }
    this._listenPromise = new Promise((resolve, reject) => {
      this._server.once('listening', resolve);
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
    const conn = new IpcConnection(sock);
    this._currentConn = conn;
    conn.on('close', () => {
      if (this._currentConn === conn) this._currentConn = null;
    });
    this.emit('connection', conn);
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
    this._decoder = new FrameDecoder();
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
    this._decoder.on('frame', (f) => this.emit('frame', f));
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

function createServer(pipePath) {
  return new IpcServer(pipePath);
}

function createClient(pipePath, opts) {
  return new IpcClient(pipePath, opts);
}

module.exports = {
  TYPE_JSON, TYPE_PTY_OUT, TYPE_PTY_IN,
  MAX_BODY,
  encodeFrame, encodeJson, encodePtyOut, encodePtyIn,
  encodePtyOutFromBytes, encodePtyInFromBytes,
  uuidToBytes, bytesToUuid,
  parsePtyFrame,
  FrameDecoder,
  IpcServer, IpcClient, IpcConnection,
  createServer, createClient,
};
