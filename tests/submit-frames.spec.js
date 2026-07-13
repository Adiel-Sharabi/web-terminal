// The pure rule behind the Codex submit fix: which PTY input frames must have their
// trailing CR withheld and written separately.
//
// Codex's TUI folds a whole read into a paste, so `hello\r` in one write types `hello`
// and a NEWLINE — the prompt never submits. Splitting the CR off is the only thing that
// makes it Enter. Claude's TUI does the same; it just takes a bigger read to trip it
// (measured: atomic submitted at 20/40/60 chars, NOT at 80/120), which is why it looked
// exempt for so long. Both split.
const { test, expect } = require('@playwright/test');
const { splitTrailingCr, isEscapeKey, CR_FRAME } = require('../lib/submit-frames');
const agents = require('../lib/agents');

const ESC = String.fromCharCode(0x1b);

test.describe('splitTrailingCr', () => {
  test('splits text + submit CR into head and a lone CR', () => {
    const s = splitTrailingCr(Buffer.from('hello\r'));
    expect(s).not.toBeNull();
    expect(s.head.toString()).toBe('hello');
    expect(s.cr).toEqual(Buffer.from([0x0d]));
  });

  test('leaves a bare CR alone — nothing precedes it to absorb it', () => {
    expect(splitTrailingCr(Buffer.from('\r'))).toBeNull();
  });

  test('leaves ordinary typing alone', () => {
    expect(splitTrailingCr(Buffer.from('h'))).toBeNull();
    expect(splitTrailingCr(Buffer.from('hello'))).toBeNull();
  });

  test('leaves LF alone — LF is not the submit key', () => {
    expect(splitTrailingCr(Buffer.from('hello\n'))).toBeNull();
  });

  test('splits the CR that follows a closed bracketed paste (multi-line compose)', () => {
    const frame = Buffer.from(`${ESC}[200~line one\rline two${ESC}[201~\r`);
    const s = splitTrailingCr(frame);
    expect(s).not.toBeNull();
    // The paste block, close marker and all, is written whole; only the final CR waits.
    expect(s.head.toString()).toBe(`${ESC}[200~line one\rline two${ESC}[201~`);
    expect(s.cr.toString()).toBe('\r');
  });

  test('a CR inside an OPEN paste is not a submit — frame does not end with it', () => {
    expect(splitTrailingCr(Buffer.from(`${ESC}[200~line one\rline two`))).toBeNull();
  });

  test('handles empty and undefined input', () => {
    expect(splitTrailingCr(Buffer.alloc(0))).toBeNull();
    expect(splitTrailingCr(undefined)).toBeNull();
  });

  test('head is a view, and head+cr reconstruct the original bytes', () => {
    const original = Buffer.from('probe submit test\r');
    const s = splitTrailingCr(original);
    expect(Buffer.concat([s.head, s.cr])).toEqual(original);
  });

  test('CR_FRAME is exactly one CR byte', () => {
    expect(CR_FRAME).toEqual(Buffer.from([0x0d]));
    expect(CR_FRAME.length).toBe(1);
  });
});

test.describe('isEscapeKey (the interrupt — #55 §6)', () => {
  test('a lone ESC byte is the Esc key', () => {
    expect(isEscapeKey(Buffer.from([0x1b]))).toBe(true);
  });

  test('an escape SEQUENCE is not the Esc key — arrows must never read as an interrupt', () => {
    expect(isEscapeKey(Buffer.from(`${ESC}[A`))).toBe(false);   // up
    expect(isEscapeKey(Buffer.from(`${ESC}[B`))).toBe(false);   // down
    expect(isEscapeKey(Buffer.from(`${ESC}[200~hi${ESC}[201~`))).toBe(false); // paste
    expect(isEscapeKey(Buffer.from(`${ESC}${ESC}`))).toBe(false); // two Escs in one read
  });

  test('ordinary text, an empty frame, and undefined are not the Esc key', () => {
    expect(isEscapeKey(Buffer.from('x'))).toBe(false);
    expect(isEscapeKey(Buffer.from('\r'))).toBe(false);
    expect(isEscapeKey(Buffer.alloc(0))).toBe(false);
    expect(isEscapeKey(undefined)).toBe(false);
  });
});

test.describe('interrupt policy lives in the registry too (#55 §6)', () => {
  test('both agents interrupt on Esc', () => {
    expect(agents.interruptsOnEscape('claude')).toBe(true);
    expect(agents.interruptsOnEscape('codex')).toBe(true);
  });

  test('a plain shell and unknown agents do NOT — Esc there belongs to vim / less / a menu', () => {
    expect(agents.interruptsOnEscape(null)).toBe(false);
    expect(agents.interruptsOnEscape(undefined)).toBe(false);
    expect(agents.interruptsOnEscape('nonesuch')).toBe(false);
    expect(agents.DEFAULT_INTERRUPT.onEscape).toBe(false);
  });
});

test.describe('submit policy lives in the registry', () => {
  test('codex bursts a trailing CR into its paste, so the CR needs a gap', () => {
    const p = agents.submitPolicy('codex');
    expect(p.crBurstsAsPaste).toBe(true);
    // Measured: <=30ms is still absorbed, >=60ms submits.
    expect(p.gapMs).toBeGreaterThanOrEqual(60);
  });

  test('claude folds a long read into a paste too, so its CR needs a gap', () => {
    // Measured on the real TUI, atomic `text\r` in ONE write: 20/40/60 chars submitted,
    // 80 and 120 did NOT — a short prompt worked, a real one was typed and never sent.
    // With the CR split off, every length submits.
    const p = agents.submitPolicy('claude');
    expect(p.crBurstsAsPaste).toBe(true);
    expect(p.gapMs).toBeGreaterThanOrEqual(60);
  });

  test('a plain shell (agent null) and unknown agents fall back to the default', () => {
    // The default splits too: an unrecorded session is usually an interactive TUI, and
    // a real shell is unharmed (a lone CR is never split; only text ENDING in CR is).
    expect(agents.submitPolicy(null).crBurstsAsPaste).toBe(true);
    expect(agents.submitPolicy(undefined).crBurstsAsPaste).toBe(true);
    expect(agents.submitPolicy('nonesuch').crBurstsAsPaste).toBe(true);
    expect(agents.submitPolicy(null)).toEqual(agents.DEFAULT_SUBMIT);
  });

  test('every provider declares a submit policy', () => {
    for (const id of agents.AGENT_IDS) {
      const p = agents.submitPolicy(id);
      expect(typeof p.gapMs, `${id}.submit.gapMs`).toBe('number');
      expect(typeof p.crBurstsAsPaste, `${id}.submit.crBurstsAsPaste`).toBe('boolean');
    }
  });
});
