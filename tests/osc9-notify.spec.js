// @ts-check
// lib/osc9-notify.js — pulling OSC 9 notification bodies out of a PTY stream that
// arrives in arbitrary chunks, plus the registry's reading of what a body MEANS.
//
// Shapes captured from a real codex-cli 0.144.0 PTY on 2026-07-21: an approval fired
//   ESC ] 9 ; Codex wants to edit 0 files BEL
// while the approval UI was on screen, and a finished turn fired the agent's last
// message the same way. The screen lies about a lot, but these bytes were read off
// the wire, not off the docs.
const { test, expect } = require('@playwright/test');
const { scanOsc9, MAX_CARRY } = require('../lib/osc9-notify');
const agents = require('../lib/agents');

const OSC9 = (body) => `\x1b]9;${body}\x07`;
const APPROVAL = 'Codex wants to edit 0 files';

test.describe('scanOsc9 — byte rule', () => {
  test('extracts a body terminated by BEL', () => {
    const r = scanOsc9('', `noise${OSC9(APPROVAL)}more`);
    expect(r.bodies).toEqual([APPROVAL]);
    expect(r.carry).toBe('');
  });

  test('accepts the ST terminator too', () => {
    const r = scanOsc9('', `\x1b]9;done\x1b\\`);
    expect(r.bodies).toEqual(['done']);
  });

  test('extracts several bodies from one chunk, in order', () => {
    const r = scanOsc9('', OSC9('first') + 'xx' + OSC9('second'));
    expect(r.bodies).toEqual(['first', 'second']);
  });

  test('ignores other OSC sequences — a title is not a notification', () => {
    // Codex emits ESC]0;<cwd>BEL immediately before its OSC 9; reading OSC 0 as a
    // notification would flip status on every title repaint.
    const r = scanOsc9('', `\x1b]0;sqlHealthCheck\x07${OSC9(APPROVAL)}`);
    expect(r.bodies).toEqual([APPROVAL]);
  });

  test('a body split across chunks is still delivered exactly once', () => {
    const whole = OSC9(APPROVAL);
    const cut = 10;
    const a = scanOsc9('', whole.slice(0, cut));
    expect(a.bodies).toEqual([]);
    const b = scanOsc9(a.carry, whole.slice(cut));
    expect(b.bodies).toEqual([APPROVAL]);
    expect(b.carry).toBe('');
  });

  test('a split INSIDE the introducer is still delivered', () => {
    // The failure a naive indexOf-only carry has: nothing to find yet, so the
    // fragment is dropped and the notification never arrives.
    const whole = OSC9(APPROVAL);
    const a = scanOsc9('', whole.slice(0, 2)); // "\x1b]"
    expect(a.carry).toBe('\x1b]');
    const b = scanOsc9(a.carry, whole.slice(2));
    expect(b.bodies).toEqual([APPROVAL]);
  });

  test('survives a byte-at-a-time stream', () => {
    const whole = `x${OSC9('one')}y${OSC9('two')}z`;
    let carry = '';
    const got = [];
    for (const ch of whole) {
      const r = scanOsc9(carry, ch);
      carry = r.carry;
      got.push(...r.bodies);
    }
    expect(got).toEqual(['one', 'two']);
  });

  test('an unterminated introducer is held, not emitted', () => {
    const r = scanOsc9('', '\x1b]9;half a message');
    expect(r.bodies).toEqual([]);
    expect(r.carry).toBe('\x1b]9;half a message');
  });

  test('the carry is bounded — a never-terminated sequence cannot grow forever', () => {
    const r = scanOsc9('', '\x1b]9;' + 'x'.repeat(MAX_CARRY + 100));
    expect(r.bodies).toEqual([]);
    expect(r.carry).toBe('');
  });

  test('plain output carries nothing between chunks', () => {
    const r = scanOsc9('', 'just ordinary terminal output\r\n');
    expect(r.bodies).toEqual([]);
    expect(r.carry).toBe('');
  });

  test('an empty body is still a notification', () => {
    expect(scanOsc9('', '\x1b]9;\x07').bodies).toEqual(['']);
  });
});

test.describe('registry — what a body means', () => {
  test('codex reads status from its output; claude and a plain shell do not', () => {
    expect(agents.readsStatusFromOutput('codex')).toBe(true);
    // Claude is hook-driven. Reading its output too would double-drive its status.
    expect(agents.readsStatusFromOutput('claude')).toBe(false);
    // The load-bearing default: a plain shell prints whatever it likes.
    expect(agents.readsStatusFromOutput(null)).toBe(false);
    expect(agents.readsStatusFromOutput('not-an-agent')).toBe(false);
  });

  test('the captured approval body classifies as an approval', () => {
    expect(agents.classifyStatusNotification('codex', APPROVAL)).toBe('approval');
  });

  test('other approval verbs classify as approvals too', () => {
    for (const b of ['Codex wants to run a command', 'codex wants to read files']) {
      expect(agents.classifyStatusNotification('codex', b)).toBe('approval');
    }
  });

  test('an ordinary last message is a finished turn, not an approval', () => {
    for (const b of ['osc9probe', 'Done — I updated two files.', '']) {
      expect(agents.classifyStatusNotification('codex', b)).toBe('turnComplete');
    }
  });

  test('the pattern is anchored — a mid-sentence mention is not an approval', () => {
    // Documented heuristic: the body must OPEN with the approval form. Without the
    // anchor, an agent explaining "...Codex wants to..." would strand the session
    // on a question that was never asked.
    expect(agents.classifyStatusNotification('codex',
      'I think Codex wants to be configured differently')).toBe('turnComplete');
  });

  test('an agent that does not declare the channel classifies nothing', () => {
    expect(agents.classifyStatusNotification('claude', APPROVAL)).toBeNull();
    expect(agents.classifyStatusNotification(null, APPROVAL)).toBeNull();
  });
});
