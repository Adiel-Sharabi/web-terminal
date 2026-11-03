// @ts-check
// ConPTY (node-pty 1.1.0's bundled conpty.dll) asks for the terminal's Primary Device
// Attributes the instant it starts and holds the shell until it is answered or ~3 s
// pass. No viewer is attached at spawn, so every session start waited those 3 s
// (measured on Home 2026-11-03: prompt at 3260 ms unanswered, 240 ms answered).
//
// lib/conpty-startup.js decides when the worker answers: ONCE, and only inside
// ConPTY's own preamble (nothing printable yet). The negatives are the load-bearing
// half - a worker-written DA1 reply landing in a running program would be typed input.
// The preamble bytes are the real ones captured from a spawn; built from code points.
const { test, expect } = require('@playwright/test');
const { createConptyStartupResponder, DA1_REPLY, ANSWER_WINDOW_MS } = require('../lib/conpty-startup');

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
// Exactly what ConPTY wrote first on Home (two chunks, 38 ms after spawn).
const PRE_1 = ESC + '[1t';
const PRE_2 = ESC + '[c' + ESC + '[?1004h' + ESC + '[?9001h';

test.describe('ConPTY startup DA1 responder', () => {
  test('answers the real preamble with the xterm.js DA1 reply', () => {
    const r = createConptyStartupResponder();
    expect(r.feed(PRE_1)).toBeNull();
    expect(r.feed(PRE_2)).toBe(ESC + '[?1;2c');
    expect(DA1_REPLY).toBe(ESC + '[?1;2c');
    expect(r.done).toBe(true);
  });

  test('answers only once per spawn', () => {
    const r = createConptyStartupResponder();
    expect(r.feed(PRE_2)).toBe(DA1_REPLY);
    expect(r.feed(PRE_2)).toBeNull();
  });

  test('a query split across chunks is still answered', () => {
    const r = createConptyStartupResponder();
    expect(r.feed(PRE_1 + ESC)).toBeNull();
    expect(r.done).toBe(false);
    expect(r.feed('[')).toBeNull();
    expect(r.done).toBe(false);
    expect(r.feed('c')).toBe(DA1_REPLY);
  });

  test('the explicit-zero form is a DA1 query too', () => {
    expect(createConptyStartupResponder().feed(ESC + '[0c')).toBe(DA1_REPLY);
  });

  test('NOT after printable output: a program asking later never gets a typed reply', () => {
    const r = createConptyStartupResponder();
    expect(r.feed(ESC + '[32madiel@host ' + ESC + '[0m$ ')).toBeNull();
    expect(r.done).toBe(true);
    expect(r.feed(ESC + '[c')).toBeNull();
  });

  test('NOT when text precedes the query in the same chunk', () => {
    const r = createConptyStartupResponder();
    expect(r.feed('hello' + ESC + '[c')).toBeNull();
    expect(r.done).toBe(true);
  });

  test('NOT for DA2, DA3 or a DA1 reply', () => {
    expect(createConptyStartupResponder().feed(ESC + '[>c')).toBeNull();
    expect(createConptyStartupResponder().feed(ESC + '[=c')).toBeNull();
    expect(createConptyStartupResponder().feed(ESC + '[?1;2c')).toBeNull();
    expect(createConptyStartupResponder().feed(ESC + '[1c')).toBeNull();
  });

  test('a title OSC before the query does not count as text', () => {
    const r = createConptyStartupResponder();
    expect(r.feed(ESC + ']0;MINGW64' + BEL + ESC + '[c')).toBe(DA1_REPLY);
  });

  // Review, 2026-11-03 (reproduced): with the worker's loop blocked past ConPTY's
  // own ~3 s timeout, the preamble and the prompt arrive as ONE chunk. ConPTY is no
  // longer waiting, so a reply then goes to bash as typed input (`1;2c` echoed, the
  // restore ran `1;2cclaude --resume <id>`). Both guards below fail toward silence.
  test('NOT when the shell already printed after the query (ConPTY gave up waiting)', () => {
    const NL = String.fromCodePoint(0x0d, 0x0a);
    const coalesced = PRE_2 + ESC + '[?2004h' + ESC + ']0;MINGW64:/c/dev' + BEL
      + NL + ESC + '[32madiel@host' + ESC + '[0m' + NL + '$ ';
    const r = createConptyStartupResponder();
    expect(r.feed(coalesced)).toBeNull();
    expect(r.done).toBe(true);
  });

  test('NOT once the answer window since the spawn has passed', () => {
    let t = 1000;
    const r = createConptyStartupResponder({ spawnedAt: 1000, now: () => t });
    t = 1000 + ANSWER_WINDOW_MS + 1;
    expect(r.feed(PRE_2)).toBeNull();
    expect(r.done).toBe(true);
  });

  test('still answers just inside the window, and the window sits well under the ~3.2 s ConPTY waits', () => {
    const r = createConptyStartupResponder({ spawnedAt: 0, now: () => ANSWER_WINDOW_MS });
    expect(r.feed(PRE_2)).toBe(DA1_REPLY);
    expect(ANSWER_WINDOW_MS).toBeLessThanOrEqual(2000);
  });

  test('gives up once the preamble outgrows anything ConPTY sends', () => {
    const r = createConptyStartupResponder();
    expect(r.feed((ESC + '[1t').repeat(2000))).toBeNull();
    expect(r.done).toBe(true);
    expect(r.feed(ESC + '[c')).toBeNull();
  });
});
