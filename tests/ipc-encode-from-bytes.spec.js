// @ts-check
// Issue #11: tests for encodePtyOutFromBytes / encodePtyInFromBytes.
//
// These helpers let callers skip the per-call uuid hex parse + 16-byte Buffer
// alloc by passing a pre-computed idBytes buffer. They MUST produce wire-
// identical frames to the legacy encodePtyOut / encodePtyIn, and MUST throw
// TypeError when given a malformed idBytes buffer (otherwise a buggy caller
// could silently corrupt the wire format).
const { test, expect } = require('@playwright/test');
const path = require('path');

function requireIpc() {
  return require(path.join(__dirname, '..', 'lib', 'ipc.js'));
}

test.describe('IPC encode*FromBytes', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const UUID_BYTES_HEX = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

  test('encodePtyOutFromBytes produces byte-identical output to encodePtyOut', () => {
    const ipc = requireIpc();
    const data = Buffer.from('hello pty output');
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');

    const fast = ipc.encodePtyOutFromBytes(idBytes, data);
    const legacy = ipc.encodePtyOut(UUID, data);

    expect(fast.equals(legacy)).toBe(true);
    // Spot-check the fields too
    expect(fast[4]).toBe(0x01); // TYPE_PTY_OUT
    expect(fast.slice(5, 21).equals(idBytes)).toBe(true);
    expect(fast.slice(21).toString()).toBe('hello pty output');
  });

  test('encodePtyInFromBytes produces byte-identical output to encodePtyIn', () => {
    const ipc = requireIpc();
    const data = Buffer.from([0x1b, 0x5b, 0x41]); // ESC [ A
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');

    const fast = ipc.encodePtyInFromBytes(idBytes, data);
    const legacy = ipc.encodePtyIn(UUID, data);

    expect(fast.equals(legacy)).toBe(true);
    expect(fast[4]).toBe(0x02); // TYPE_PTY_IN
    expect(fast.slice(5, 21).equals(idBytes)).toBe(true);
    expect(fast.slice(21).equals(data)).toBe(true);
  });

  test('encodePtyOutFromBytes accepts string data (auto Buffer.from)', () => {
    const ipc = requireIpc();
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');
    const fast = ipc.encodePtyOutFromBytes(idBytes, 'stringly-typed');
    const legacy = ipc.encodePtyOut(UUID, 'stringly-typed');
    expect(fast.equals(legacy)).toBe(true);
  });

  test('encodePtyOutFromBytes handles large payloads (1 MB)', () => {
    const ipc = requireIpc();
    const big = Buffer.alloc(1024 * 1024, 0x42); // 1MB of 'B'
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');
    const fast = ipc.encodePtyOutFromBytes(idBytes, big);
    const legacy = ipc.encodePtyOut(UUID, big);
    expect(fast.equals(legacy)).toBe(true);
    expect(fast.length).toBe(4 + 1 + 16 + big.length);
  });

  test('encodePtyOutFromBytes throws TypeError on wrong-length buffer', () => {
    const ipc = requireIpc();
    const data = Buffer.from('x');
    expect(() => ipc.encodePtyOutFromBytes(Buffer.alloc(15), data))
      .toThrow(TypeError);
    expect(() => ipc.encodePtyOutFromBytes(Buffer.alloc(17), data))
      .toThrow(TypeError);
    expect(() => ipc.encodePtyOutFromBytes(Buffer.alloc(0), data))
      .toThrow(TypeError);
  });

  test('encodePtyOutFromBytes throws TypeError on non-Buffer idBytes', () => {
    const ipc = requireIpc();
    const data = Buffer.from('x');
    expect(() => ipc.encodePtyOutFromBytes(UUID, data))
      .toThrow(TypeError);
    expect(() => ipc.encodePtyOutFromBytes(null, data))
      .toThrow(TypeError);
    expect(() => ipc.encodePtyOutFromBytes(undefined, data))
      .toThrow(TypeError);
    // Uint8Array of correct length but not a Buffer — Buffer.isBuffer returns
    // false, so this should also throw for defense-in-depth (the downstream
    // Buffer.concat wouldn't mind, but we want a strict contract).
    expect(() => ipc.encodePtyOutFromBytes(new Uint8Array(16), data))
      .toThrow(TypeError);
  });

  test('encodePtyInFromBytes throws TypeError on wrong-length buffer', () => {
    const ipc = requireIpc();
    const data = Buffer.from('x');
    expect(() => ipc.encodePtyInFromBytes(Buffer.alloc(15), data))
      .toThrow(TypeError);
    expect(() => ipc.encodePtyInFromBytes(Buffer.alloc(17), data))
      .toThrow(TypeError);
  });

  test('round-trip: FrameDecoder+parsePtyFrame recovers sessionId and data', () => {
    const ipc = requireIpc();
    const data = Buffer.from('round-trip-payload');
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');

    const frameBuf = ipc.encodePtyOutFromBytes(idBytes, data);

    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    decoder.push(frameBuf);

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(0x01);
    const parsed = ipc.parsePtyFrame(frames[0]);
    expect(parsed.sessionId).toBe(UUID);
    expect(parsed.data.equals(data)).toBe(true);
  });

  test('round-trip: encodePtyInFromBytes -> FrameDecoder -> parsePtyFrame', () => {
    const ipc = requireIpc();
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const idBytes = Buffer.from(UUID_BYTES_HEX, 'hex');

    const frameBuf = ipc.encodePtyInFromBytes(idBytes, data);

    const decoder = new ipc.FrameDecoder();
    const frames = [];
    decoder.on('frame', f => frames.push(f));
    decoder.push(frameBuf);

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(0x02);
    const parsed = ipc.parsePtyFrame(frames[0]);
    expect(parsed.sessionId).toBe(UUID);
    expect(parsed.data.equals(data)).toBe(true);
  });

  test('uuidToBytes is exported and round-trips with bytesToUuid', () => {
    const ipc = requireIpc();
    expect(typeof ipc.uuidToBytes).toBe('function');
    expect(typeof ipc.bytesToUuid).toBe('function');
    const idBytes = ipc.uuidToBytes(UUID);
    expect(idBytes.length).toBe(16);
    expect(ipc.bytesToUuid(idBytes)).toBe(UUID);
  });

  test('caller can cache idBytes once and reuse for many encodes', () => {
    const ipc = requireIpc();
    const idBytes = ipc.uuidToBytes(UUID);
    // Many iterations must all yield the same wire bytes as the legacy path.
    for (let i = 0; i < 100; i++) {
      const data = Buffer.from(`chunk-${i}`);
      const fast = ipc.encodePtyOutFromBytes(idBytes, data);
      const legacy = ipc.encodePtyOut(UUID, data);
      expect(fast.equals(legacy)).toBe(true);
    }
  });
});
