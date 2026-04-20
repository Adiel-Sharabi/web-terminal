// @ts-check
// Tests for issue #14: FrameDecoder chunk-list implementation.
//
// Verifies:
//   - byte-for-byte output compatibility with the old decoder
//   - correct handling of headers/payloads that span chunks
//   - many tiny frames packed into one push()
//   - zero-length payloads (body len = 1, type byte only)
//   - randomized chunk splits decode identically to a single push()
//   - a 2 MB frame split into 32 * 64 KB chunks decodes in reasonable time
//     (regression guard — this is where the old O(n²) concat hurt)
//   - malformed length headers don't crash / don't OOM

const { test, expect } = require('@playwright/test');
const path = require('path');
const crypto = require('crypto');

function requireIpc() {
  return require(path.join(__dirname, '..', 'lib', 'ipc.js'));
}

function collectFrames(decoder) {
  const frames = [];
  const errors = [];
  decoder.on('frame', (f) => frames.push({ type: f.type, payload: Buffer.from(f.payload) }));
  decoder.on('error', (err) => errors.push(err));
  return { frames, errors };
}

test.describe('FrameDecoder chunk-list model (issue #14)', () => {
  test('2 MB frame split into 32 * 64 KB chunks decodes correctly and quickly', () => {
    const ipc = requireIpc();
    const SIZE = 2 * 1024 * 1024; // 2 MB payload
    const CHUNK = 64 * 1024;
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const payload = crypto.randomBytes(SIZE);
    const framed = ipc.encodePtyOut(sessionId, payload);

    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);

    const start = process.hrtime.bigint();
    for (let off = 0; off < framed.length; off += CHUNK) {
      decoder.push(framed.slice(off, Math.min(off + CHUNK, framed.length)));
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(ipc.TYPE_PTY_OUT);
    const parsed = ipc.parsePtyFrame(frames[0]);
    expect(parsed.sessionId).toBe(sessionId);
    expect(Buffer.compare(parsed.data, payload)).toBe(0);

    // Ballpark — with the old O(n²) concat this same test took noticeably
    // longer; with the chunk-list model it should be well under a second
    // on any reasonable machine. 5 s is a very loose regression guard.
    expect(elapsedMs).toBeLessThan(5000);
  });

  test('4-byte header split across chunks (1 byte then 3 bytes) assembles correctly', () => {
    const ipc = requireIpc();
    const payload = Buffer.from('x'); // 1-byte payload, body = 1 + 1 = 2
    const framed = ipc.encodeFrame(ipc.TYPE_JSON, payload);
    // framed.length = 4 + 2 = 6; header = framed[0..4]

    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);

    decoder.push(framed.slice(0, 1));  // 1 byte of header
    decoder.push(framed.slice(1, 4));  // remaining 3 bytes of header
    decoder.push(framed.slice(4));     // body

    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(ipc.TYPE_JSON);
    expect(Buffer.compare(frames[0].payload, payload)).toBe(0);
  });

  test('many tiny frames in one push all parse out', () => {
    const ipc = requireIpc();
    const N = 500;
    const parts = [];
    const expected = [];
    for (let i = 0; i < N; i++) {
      const payload = Buffer.from(`f${i}`);
      parts.push(ipc.encodeFrame(ipc.TYPE_JSON, payload));
      expected.push(payload);
    }
    const big = Buffer.concat(parts);

    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);
    decoder.push(big);

    expect(errors).toEqual([]);
    expect(frames).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(frames[i].type).toBe(ipc.TYPE_JSON);
      expect(Buffer.compare(frames[i].payload, expected[i])).toBe(0);
    }
  });

  test('zero-length payload (body = 1, just the type byte) emits a valid frame', () => {
    const ipc = requireIpc();
    // Hand-build: length = 1, type byte = TYPE_JSON, no payload.
    const framed = Buffer.alloc(5);
    framed.writeUInt32LE(1, 0);
    framed[4] = ipc.TYPE_JSON;

    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);
    decoder.push(framed);

    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(ipc.TYPE_JSON);
    expect(frames[0].payload.length).toBe(0);
  });

  test('random-size chunk splits of a multi-frame stream decode identically to one push()', () => {
    const ipc = requireIpc();
    // Build a multi-frame stream of varying sizes + types.
    const parts = [];
    const expected = [];
    const rand = (n) => crypto.randomBytes(n);
    const sizes = [0, 1, 7, 32, 500, 4096, 65536, 131072, 3, 17, 250000];
    for (const s of sizes) {
      const p = rand(s);
      const t = (s % 3 === 0) ? ipc.TYPE_JSON
              : (s % 3 === 1) ? ipc.TYPE_PTY_OUT
              :                 ipc.TYPE_PTY_IN;
      parts.push(ipc.encodeFrame(t, p));
      expected.push({ type: t, payload: p });
    }
    const full = Buffer.concat(parts);

    // Reference: single push
    const refDecoder = new ipc.FrameDecoder();
    const ref = collectFrames(refDecoder);
    refDecoder.push(full);

    // Do many random chunk splits and compare.
    for (let trial = 0; trial < 10; trial++) {
      const decoder = new ipc.FrameDecoder();
      const { frames, errors } = collectFrames(decoder);
      let off = 0;
      while (off < full.length) {
        const remaining = full.length - off;
        // Pick a random chunk size between 1 and 70000 bytes.
        const size = Math.min(remaining, 1 + Math.floor(Math.random() * 70000));
        decoder.push(full.slice(off, off + size));
        off += size;
      }
      expect(errors).toEqual([]);
      expect(frames).toHaveLength(ref.frames.length);
      for (let i = 0; i < frames.length; i++) {
        expect(frames[i].type).toBe(ref.frames[i].type);
        expect(Buffer.compare(frames[i].payload, ref.frames[i].payload)).toBe(0);
      }
    }
  });

  test('malformed length header (length = 0) raises error and does not OOM', () => {
    const ipc = requireIpc();
    const bad = Buffer.alloc(5);
    bad.writeUInt32LE(0, 0); // invalid (len must be >= 1)
    bad[4] = 0x00;
    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);
    decoder.push(bad);
    expect(frames).toHaveLength(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/Invalid frame length/);
  });

  test('malformed length header (length > MAX_BODY) raises error', () => {
    const ipc = requireIpc();
    const bad = Buffer.alloc(5);
    bad.writeUInt32LE(ipc.MAX_BODY + 1, 0);
    bad[4] = 0x00;
    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);
    decoder.push(bad);
    expect(frames).toHaveLength(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/Invalid frame length/);
  });

  test('payload split byte-by-byte across chunks reassembles exactly', () => {
    const ipc = requireIpc();
    const payload = crypto.randomBytes(1024);
    const framed = ipc.encodeFrame(ipc.TYPE_PTY_IN, payload);
    const decoder = new ipc.FrameDecoder();
    const { frames, errors } = collectFrames(decoder);
    for (let i = 0; i < framed.length; i++) {
      decoder.push(framed.slice(i, i + 1));
    }
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(ipc.TYPE_PTY_IN);
    expect(Buffer.compare(frames[0].payload, payload)).toBe(0);
  });
});
