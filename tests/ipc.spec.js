// @ts-check
// TDD tests for lib/ipc.js — framing + pipe server/client helpers
const { test, expect } = require('@playwright/test');
const path = require('path');
const crypto = require('crypto');

// Imported lazily so the test file loads even before lib/ipc.js exists;
// each test requires it just-in-time so Playwright reports a clean failure.
function requireIpc() {
  return require(path.join(__dirname, '..', 'lib', 'ipc.js'));
}

// ============================================================
// Framing: encode/decode
// ============================================================

test.describe('IPC framing', () => {
  test('encodeJson produces 4-byte LE length prefix + type byte + JSON utf8', () => {
    const ipc = requireIpc();
    const buf = ipc.encodeJson({ hello: 'world' });
    // Length = body size (type + payload) = 1 + JSON.stringify length
    const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    expect(buf.readUInt32LE(0)).toBe(1 + body.length);
    expect(buf[4]).toBe(0x00); // type JSON
    expect(buf.slice(5).toString('utf8')).toBe(JSON.stringify({ hello: 'world' }));
  });

  test('encodePtyOut produces type=1, 16-byte UUID, raw bytes', () => {
    const ipc = requireIpc();
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const data = Buffer.from('hello pty');
    const buf = ipc.encodePtyOut(id, data);
    expect(buf[4]).toBe(0x01);
    // next 16 bytes = UUID as bytes (hex parse)
    const uuidBytes = Buffer.from(id.replace(/-/g, ''), 'hex');
    expect(buf.slice(5, 21)).toEqual(uuidBytes);
    expect(buf.slice(21).toString()).toBe('hello pty');
  });

  test('encodePtyIn produces type=2, 16-byte UUID, raw bytes', () => {
    const ipc = requireIpc();
    const id = '11111111-2222-3333-4444-555555555555';
    const data = Buffer.from([0x1b, 0x5b, 0x41]); // ESC [ A
    const buf = ipc.encodePtyIn(id, data);
    expect(buf[4]).toBe(0x02);
    const uuidBytes = Buffer.from(id.replace(/-/g, ''), 'hex');
    expect(buf.slice(5, 21)).toEqual(uuidBytes);
    expect(buf.slice(21)).toEqual(data);
  });

  test('FrameDecoder parses a single complete frame', () => {
    const ipc = requireIpc();
    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    decoder.push(ipc.encodeJson({ a: 1 }));
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(0x00);
    expect(JSON.parse(frames[0].payload.toString('utf8'))).toEqual({ a: 1 });
  });

  test('FrameDecoder handles multiple frames in one push', () => {
    const ipc = requireIpc();
    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    const f1 = ipc.encodeJson({ a: 1 });
    const f2 = ipc.encodeJson({ b: 2 });
    decoder.push(Buffer.concat([f1, f2]));
    expect(frames.length).toBe(2);
    expect(JSON.parse(frames[0].payload.toString())).toEqual({ a: 1 });
    expect(JSON.parse(frames[1].payload.toString())).toEqual({ b: 2 });
  });

  test('FrameDecoder handles frames split across pushes (fragmentation)', () => {
    const ipc = requireIpc();
    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    const full = ipc.encodeJson({ test: 'fragmented' });
    // Split at every possible boundary
    for (let split = 1; split < full.length; split++) {
      const d2 = new ipc.FrameDecoder();
      const received = [];
      d2.on('frame', f => received.push(f));
      d2.push(full.slice(0, split));
      d2.push(full.slice(split));
      expect(received.length, `split at ${split}`).toBe(1);
      expect(JSON.parse(received[0].payload.toString())).toEqual({ test: 'fragmented' });
    }
  });

  test('FrameDecoder handles large payloads (1 MB)', () => {
    const ipc = requireIpc();
    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    const big = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
    const id = '00000000-0000-0000-0000-000000000000';
    decoder.push(ipc.encodePtyOut(id, big));
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(0x01);
    expect(frames[0].payload.length).toBe(16 + big.length);
    expect(frames[0].payload.slice(16).equals(big)).toBe(true);
  });

  test('parsePtyFrame returns {sessionId, data}', () => {
    const ipc = requireIpc();
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const data = Buffer.from('test');
    const frame = { type: 0x01, payload: Buffer.concat([Buffer.from(id.replace(/-/g, ''), 'hex'), data]) };
    const parsed = ipc.parsePtyFrame(frame);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.data.toString()).toBe('test');
  });
});

// ============================================================
// Pipe server / client — round-trip over named pipe
// ============================================================

test.describe('IPC pipe server/client', () => {
  // Unique pipe name per test to avoid collisions
  function pipeName() {
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\wt-test-${crypto.randomUUID()}`
      : `/tmp/wt-test-${crypto.randomUUID()}.sock`;
  }

  test('client connects, server accepts, JSON round-trip', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const server = ipc.createServer(p);
    await server.listening();

    let serverSawFrame = null;
    server.on('connection', (conn) => {
      conn.on('frame', (frame) => {
        serverSawFrame = frame;
        conn.send(ipc.encodeJson({ echo: JSON.parse(frame.payload.toString()) }));
      });
    });

    const client = ipc.createClient(p);
    await client.connected();

    const received = new Promise(resolve => {
      client.on('frame', f => resolve(f));
    });

    client.send(ipc.encodeJson({ hi: 'there' }));
    const reply = await received;

    expect(reply.type).toBe(0x00);
    expect(JSON.parse(reply.payload.toString())).toEqual({ echo: { hi: 'there' } });

    await client.close();
    await server.close();
  });

  test('server rejects second client (one client at a time)', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const server = ipc.createServer(p);
    await server.listening();

    const c1 = ipc.createClient(p);
    await c1.connected();

    const c2 = ipc.createClient(p);
    let rejected = false;
    c2.on('close', () => { rejected = true; });
    // Wait a tick for the server to reject
    await new Promise(r => setTimeout(r, 300));
    expect(rejected).toBe(true);

    await c1.close();
    await server.close();
  });

  test('client auto-reconnects if connection drops (retry path)', async () => {
    const ipc = requireIpc();
    const p = pipeName();
    const server = ipc.createServer(p);
    await server.listening();

    // Create client with retry enabled
    const client = ipc.createClient(p, { retry: true, retryDelayMs: 50 });
    await client.connected();

    // Close server, restart it quickly — client should reconnect
    let reconnects = 0;
    client.on('connected', () => reconnects++);
    await server.close();
    // Brief pause, then reopen
    await new Promise(r => setTimeout(r, 100));
    const server2 = ipc.createServer(p);
    await server2.listening();
    // Give client time to reconnect
    await new Promise(r => setTimeout(r, 500));
    expect(reconnects).toBeGreaterThanOrEqual(1);

    await client.close();
    await server2.close();
  });
});
