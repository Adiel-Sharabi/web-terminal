// @ts-check
// Unit tests for lib/replay-sanitize.js — the scrollback replay sanitizer that
// strips terminal *queries* (Device Attributes, Device Status Report) so they
// are not auto-answered into an idle shell on re-attach.
//
// Regression target: the "1;2c1;2cclaude --dangerously-skip-permissions" bug,
// where a DA query left in replayed scrollback caused xterm to answer
// "ESC[?1;2c" into the command line, leaving "1;2c" garbage on a fresh prompt.
//
// Pure module test — no server, no worker, no browser.

const { test, expect } = require('@playwright/test');
const { sanitizeReplay } = require('../lib/replay-sanitize');

const ESC = '\x1b';

test.describe('sanitizeReplay', () => {
  test('strips a Primary Device Attributes query (ESC[c)', () => {
    expect(sanitizeReplay(`hello${ESC}[cworld`)).toBe('helloworld');
  });

  test('strips DA1 with a parameter (ESC[0c)', () => {
    expect(sanitizeReplay(`${ESC}[0c`)).toBe('');
  });

  test('strips a DA reply (ESC[?1;2c) — the exact bytes from the bug', () => {
    // Two replies, as seen in the report ("1;2c1;2c").
    expect(sanitizeReplay(`${ESC}[?1;2c${ESC}[?1;2c`)).toBe('');
  });

  test('strips Secondary/Tertiary DA queries (ESC[>c, ESC[=c)', () => {
    expect(sanitizeReplay(`${ESC}[>c`)).toBe('');
    expect(sanitizeReplay(`${ESC}[>0;276;0c`)).toBe('');
    expect(sanitizeReplay(`${ESC}[=c`)).toBe('');
  });

  test('strips DSR cursor-position and status queries (ESC[6n, ESC[5n)', () => {
    expect(sanitizeReplay(`a${ESC}[6nb${ESC}[5nc`)).toBe('abc');
    expect(sanitizeReplay(`${ESC}[?6n`)).toBe('');
  });

  test('still strips erase-display and alt-screen toggles (legacy behavior)', () => {
    expect(sanitizeReplay(`${ESC}[2Jx`)).toBe('x');
    expect(sanitizeReplay(`${ESC}[3Jx`)).toBe('x');
    expect(sanitizeReplay(`${ESC}[?1049hx${ESC}[?1049l`)).toBe('x');
  });

  test('does NOT strip SGR color sequences (end in m)', () => {
    const s = `${ESC}[31mred${ESC}[0m`;
    expect(sanitizeReplay(s)).toBe(s);
  });

  test('does NOT strip cursor movement / positioning (end in H, A-D, K)', () => {
    const s = `${ESC}[2A${ESC}[10;5H${ESC}[Ktext${ESC}[1B`;
    expect(sanitizeReplay(s)).toBe(s);
  });

  test('does NOT strip bracketed-paste mode toggles (end in h/l)', () => {
    const s = `${ESC}[?2004h paste ${ESC}[?2004l`;
    expect(sanitizeReplay(s)).toBe(s);
  });

  test('does NOT strip the cursor-show/hide private modes (ESC[?25h/l)', () => {
    const s = `${ESC}[?25l${ESC}[?25h`;
    expect(sanitizeReplay(s)).toBe(s);
  });

  test('leaves plain text and newlines untouched', () => {
    const s = 'line one\r\nline two\r\n$ ';
    expect(sanitizeReplay(s)).toBe(s);
  });

  test('handles empty / falsy input', () => {
    expect(sanitizeReplay('')).toBe('');
    expect(sanitizeReplay(undefined)).toBe(undefined);
    expect(sanitizeReplay(null)).toBe(null);
  });

  test('strips queries interleaved with real output (realistic Claude frame)', () => {
    const input = `${ESC}[?2004h$ ${ESC}[6nclaude${ESC}[c starting${ESC}[0m`;
    // Bracketed-paste enable and SGR survive; DA + DSR removed.
    expect(sanitizeReplay(input)).toBe(`${ESC}[?2004h$ claude starting${ESC}[0m`);
  });
});
