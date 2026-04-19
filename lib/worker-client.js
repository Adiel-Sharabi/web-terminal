// lib/worker-client.js — thin wrapper around lib/ipc for server.js to talk to pty-worker.
//
// Usage:
//   const wc = require('./lib/worker-client');
//   const w = wc.create();
//   await w.connect('\\\\.\\pipe\\web-terminal-pty');
//   const { sessions } = await w.rpc('listSessions');
//   w.on('sessionCreated', (params) => { ... });
//   w.onExit(() => process.exit(1));

const { EventEmitter } = require('events');
const ipc = require('./ipc');

class WorkerClient extends EventEmitter {
  constructor() {
    super();
    this._client = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._connected = false;
    this._exitHandlers = [];
    this._defaultTimeoutMs = 30000;
    // Per-session PTY_OUT listeners: Map<sessionId, Set<handler(Buffer)>>
    this._ptyOutHandlers = new Map();
  }

  /**
   * Connect to the worker. Retries until connected or attempts exhausted.
   * Resolves when the first ping succeeds, rejects otherwise.
   */
  async connect(pipePath, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 30;
    const delayMs = opts.delayMs ?? 200;
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this._tryConnect(pipePath);
        const pong = await this.rpc('ping', {}, 3000);
        if (pong && pong.ok) {
          this._connected = true;
          return;
        }
      } catch (e) {
        lastErr = e;
        try { if (this._client) this._client.close(); } catch {}
        this._client = null;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(`worker-client: failed to connect to ${pipePath}: ${lastErr?.message || 'unknown'}`);
  }

  _tryConnect(pipePath) {
    return new Promise((resolve, reject) => {
      const client = ipc.createClient(pipePath, { retry: false });
      client.connected().then(() => {
        this._client = client;
        this._wireClient(client);
        resolve();
      }).catch(reject);
    });
  }

  _wireClient(client) {
    client.on('frame', (frame) => {
      if (frame.type === ipc.TYPE_JSON) {
        let msg;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
        if (msg.id != null) {
          const pending = this._pending.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this._pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
        } else if (msg.event) {
          // Emit the worker-pushed event
          this.emit(msg.event, msg.params || {});
        }
      } else if (frame.type === ipc.TYPE_PTY_OUT) {
        // Route binary PTY output to per-session handlers.
        let parsed;
        try { parsed = ipc.parsePtyFrame(frame); } catch { return; }
        const handlers = this._ptyOutHandlers.get(parsed.sessionId);
        if (handlers) {
          for (const h of handlers) {
            try { h(parsed.data); } catch {}
          }
        }
        // Also re-emit raw frame for any low-level listener.
        this.emit('frame', frame);
      } else {
        // Other binary frame types — re-emit raw for low-level use.
        this.emit('frame', frame);
      }
    });
    client.on('close', () => {
      this._connected = false;
      // Reject all pending RPCs
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        try { pending.reject(new Error('worker disconnected')); } catch {}
      }
      this._pending.clear();
      for (const h of this._exitHandlers) {
        try { h(); } catch {}
      }
      this.emit('close');
    });
    client.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Send an RPC request, returns a Promise<result>. */
  rpc(method, params = {}, timeoutMs) {
    if (!this._client) return Promise.reject(new Error('worker-client: not connected'));
    const id = this._nextId++;
    const to = timeoutMs ?? this._defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC ${method} timed out after ${to}ms`));
      }, to);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._client.send(ipc.encodeJson({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /** Subscribe to worker-pushed events (sessionCreated, sessionExited, statusChanged). */
  // on() is inherited from EventEmitter — added here for documentation only.

  /** Register a callback invoked when the worker disconnects. */
  onExit(handler) {
    this._exitHandlers.push(handler);
  }

  /** Send a raw binary frame (for PTY_IN/PTY_OUT in Phase 4). */
  sendFrame(buf) {
    if (!this._client) return false;
    return this._client.send(buf);
  }

  /**
   * Register a handler to receive PTY_OUT bytes for a single session id.
   * Returns a dispose function that unregisters the handler.
   */
  onPtyOut(sessionId, handler) {
    let set = this._ptyOutHandlers.get(sessionId);
    if (!set) { set = new Set(); this._ptyOutHandlers.set(sessionId, set); }
    set.add(handler);
    return () => {
      const cur = this._ptyOutHandlers.get(sessionId);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this._ptyOutHandlers.delete(sessionId);
    };
  }

  /** Remove all PTY_OUT handlers for a given session id. */
  offPtyOut(sessionId) {
    this._ptyOutHandlers.delete(sessionId);
  }

  /** Send a PTY_IN binary frame (keystrokes) to the worker for the given session. */
  sendPtyIn(sessionId, data) {
    if (!this._client) return false;
    return this._client.send(ipc.encodePtyIn(sessionId, data));
  }

  close() {
    if (this._client) {
      try { this._client.close(); } catch {}
      this._client = null;
    }
    this._connected = false;
  }

  isConnected() { return this._connected; }
}

function create() {
  return new WorkerClient();
}

module.exports = { create, WorkerClient };
