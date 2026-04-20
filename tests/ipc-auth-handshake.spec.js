// @ts-check
// Issue #18 — defense-in-depth auth on the worker IPC pipe:
//   1. Unix chmod 0600 on the socket file (test below verifies this).
//   2. Windows DACL investigation: Node's default pipe DACL grants
//      Everyone: Read and ANONYMOUS LOGON: Read. Write is NOT granted to
//      non-admin users, so they cannot issue RPCs, but the default ACL still
//      leaks readable data to the local station. Setting a restrictive DACL
//      requires native P/Invoke; we rely on the handshake (layer 3) instead.
//      Finding documented here; no programmatic Windows test.
//   3. App-level handshake: client sends a HANDSHAKE frame (type 0x03) with
//      a shared-secret token as the first frame; server closes the
//      connection on any other first frame or wrong token.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function requireIpc() {
  return require(path.join(__dirname, '..', 'lib', 'ipc.js'));
}

function pipeName() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-auth-test-${crypto.randomUUID()}`
    : `/tmp/wt-auth-test-${crypto.randomUUID()}.sock`;
}

async function rpcRoundTrip(server, client, method, id) {
  const frame = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('rpc round-trip timeout')), 2000);
    client.on('frame', f => {
      clearTimeout(to);
      resolve(f);
    });
    // Server side echoes the first JSON frame back.
    server.once('connection', (conn) => {
      conn.on('frame', f => {
        if (f.type === 0x00) {
          try {
            const msg = JSON.parse(f.payload.toString('utf8'));
            conn.send(require(path.join(__dirname, '..', 'lib', 'ipc.js'))
              .encodeJson({ id: msg.id, result: { method: msg.method, ok: true } }));
          } catch {}
        }
      });
    });
    const ipc = requireIpc();
    client.send(ipc.encodeJson({ id, method, params: {} }));
  });
  return frame;
}

test.describe('IPC handshake auth', () => {
  test('connection with correct token succeeds and normal RPC works', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const token = ipc.generateToken();

    const server = ipc.createServer(p, { authToken: token });
    await server.listening();

    let conn = null;
    server.on('connection', (c) => {
      conn = c;
      c.on('frame', (f) => {
        if (f.type === 0x00) {
          const msg = JSON.parse(f.payload.toString('utf8'));
          c.send(ipc.encodeJson({ id: msg.id, result: { echoed: msg.method } }));
        }
      });
    });

    const client = ipc.createClient(p, { authToken: token });
    await client.connected();

    const reply = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no reply')), 2000);
      client.on('frame', f => {
        if (f.type === 0x00) {
          clearTimeout(to);
          resolve(JSON.parse(f.payload.toString('utf8')));
        }
      });
      client.send(ipc.encodeJson({ id: 1, method: 'ping', params: {} }));
    });

    expect(reply).toEqual({ id: 1, result: { echoed: 'ping' } });
    expect(conn).not.toBeNull();

    await client.close();
    await server.close();
  });

  test('wrong token → connection is rejected before any RPC response', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const serverToken = ipc.generateToken();
    const clientToken = ipc.generateToken(); // different random token

    const server = ipc.createServer(p, { authToken: serverToken });
    await server.listening();

    let serverSawConnection = false;
    let authFail = null;
    server.on('connection', () => { serverSawConnection = true; });
    server.on('authFail', (err) => { authFail = err; });

    const client = ipc.createClient(p, { authToken: clientToken });
    await client.connected();

    let replies = 0;
    client.on('frame', () => { replies++; });

    // Send a real RPC — should be dropped because the socket got destroyed
    // right after the bad handshake.
    try { client.send(ipc.encodeJson({ id: 1, method: 'ping', params: {} })); } catch {}

    // Wait a bit for the server to reject.
    await new Promise(r => setTimeout(r, 500));

    expect(serverSawConnection).toBe(false);
    expect(replies).toBe(0);
    expect(authFail).not.toBeNull();
    expect(authFail.message).toMatch(/mismatch/i);

    await client.close();
    await server.close();
  });

  test('missing handshake (first frame is a regular RPC) → rejected', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const serverToken = ipc.generateToken();

    const server = ipc.createServer(p, { authToken: serverToken });
    await server.listening();

    let serverSawConnection = false;
    let authFail = null;
    server.on('connection', () => { serverSawConnection = true; });
    server.on('authFail', (err) => { authFail = err; });

    // Build a client that sends a JSON frame as its very first frame — i.e.
    // no handshake. We use a raw net socket for this to bypass the IpcClient
    // handshake logic. This mimics an attacker connecting to the pipe and
    // sending commands directly.
    const net = require('net');
    await new Promise((resolve, reject) => {
      const sock = net.createConnection(p);
      sock.once('connect', () => {
        sock.write(ipc.encodeJson({ id: 1, method: 'ping', params: {} }));
        // Wait a bit for the server to reject.
        setTimeout(() => {
          let gotBytes = false;
          sock.on('data', () => { gotBytes = true; });
          setTimeout(() => {
            try { sock.destroy(); } catch {}
            resolve(gotBytes);
          }, 300);
        }, 300);
      });
      sock.once('error', reject);
    });

    expect(serverSawConnection).toBe(false);
    expect(authFail).not.toBeNull();
    expect(authFail.message).toMatch(/not a valid handshake/i);

    await server.close();
  });

  test('no-token mode (back-compat): server/client both tokenless work', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    // Explicitly null to override any ambient WT_IPC_TOKEN env var (tests
    // don't set one, but be defensive).
    const server = ipc.createServer(p, { authToken: null });
    await server.listening();

    server.on('connection', (c) => {
      c.on('frame', (f) => {
        if (f.type === 0x00) {
          const msg = JSON.parse(f.payload.toString('utf8'));
          c.send(ipc.encodeJson({ id: msg.id, result: { noauth: true } }));
        }
      });
    });

    const client = ipc.createClient(p, { authToken: null });
    await client.connected();

    const reply = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no reply')), 2000);
      client.on('frame', f => {
        if (f.type === 0x00) {
          clearTimeout(to);
          resolve(JSON.parse(f.payload.toString('utf8')));
        }
      });
      client.send(ipc.encodeJson({ id: 7, method: 'ping', params: {} }));
    });

    expect(reply.result.noauth).toBe(true);
    await client.close();
    await server.close();
  });

  test('pipe file is chmod 0600 after listen (unix only)', async () => {
    test.skip(process.platform === 'win32',
      'Windows named pipes do not live on the filesystem and fs.chmod is not applicable. ' +
      'Default Node.js pipe DACL grants Everyone Read (probed with NamedPipeClientStream.GetAccessControl()). ' +
      'We rely on the app-level handshake for defense on Windows — setting a restrictive DACL ' +
      'would require native P/Invoke.');
    const ipc = requireIpc();
    const p = pipeName();
    const server = ipc.createServer(p, { authToken: ipc.generateToken() });
    await server.listening();
    const st = fs.statSync(p);
    // mode & 0o777 masks out file-type bits
    expect((st.mode & 0o777)).toBe(0o600);
    await server.close();
  });

  test('handshake frame with wrong type as first frame → rejected', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const serverToken = ipc.generateToken();

    const server = ipc.createServer(p, { authToken: serverToken });
    await server.listening();

    let serverSawConnection = false;
    let authFail = null;
    server.on('connection', () => { serverSawConnection = true; });
    server.on('authFail', (err) => { authFail = err; });

    const net = require('net');
    await new Promise((resolve) => {
      const sock = net.createConnection(p);
      sock.once('connect', () => {
        // Send a PTY_OUT frame as the first frame (wrong type)
        const fake = ipc.encodePtyOut('00000000-0000-0000-0000-000000000000', Buffer.from('hi'));
        sock.write(fake);
        setTimeout(() => { try { sock.destroy(); } catch {}; resolve(); }, 400);
      });
    });

    expect(serverSawConnection).toBe(false);
    expect(authFail).not.toBeNull();
    await server.close();
  });

  test('token comparison is length-safe (rejects shorter token without throwing)', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const serverToken = Buffer.alloc(32, 0x01);
    const shortToken = Buffer.alloc(8, 0x01);

    const server = ipc.createServer(p, { authToken: serverToken });
    await server.listening();

    let authFail = null;
    server.on('authFail', (err) => { authFail = err; });

    const client = ipc.createClient(p, { authToken: shortToken });
    await client.connected();

    await new Promise(r => setTimeout(r, 300));

    expect(authFail).not.toBeNull();
    expect(authFail.message).toMatch(/mismatch/i);

    await client.close();
    await server.close();
  });

  test('env var WT_IPC_TOKEN is picked up automatically', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const prev = process.env.WT_IPC_TOKEN;
    const tok = ipc.generateToken();
    process.env.WT_IPC_TOKEN = tok;
    try {
      const server = ipc.createServer(p); // no opts — reads env
      await server.listening();
      const client = ipc.createClient(p); // no opts — reads env
      await client.connected();

      const reply = await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('no reply')), 2000);
        server.on('connection', (c) => {
          c.on('frame', (f) => {
            if (f.type === 0x00) {
              const msg = JSON.parse(f.payload.toString('utf8'));
              c.send(ipc.encodeJson({ id: msg.id, result: { env: true } }));
            }
          });
        });
        client.on('frame', f => {
          if (f.type === 0x00) {
            clearTimeout(to);
            resolve(JSON.parse(f.payload.toString('utf8')));
          }
        });
        client.send(ipc.encodeJson({ id: 9, method: 'ping', params: {} }));
      });
      expect(reply.result.env).toBe(true);

      await client.close();
      await server.close();
    } finally {
      if (prev === undefined) delete process.env.WT_IPC_TOKEN;
      else process.env.WT_IPC_TOKEN = prev;
    }
  });
});
