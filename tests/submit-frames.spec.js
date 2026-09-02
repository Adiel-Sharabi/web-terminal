// The pure rule behind the Codex submit fix: which PTY input frames must have their
// trailing CR withheld and written separately.
//
// Codex's TUI folds a whole read into a paste, so `hello\r` in one write types `hello`
// and a NEWLINE — the prompt never submits. Splitting the CR off is the only thing that
// makes it Enter. Claude's TUI does the same; it just takes a bigger read to trip it
// (measured: atomic submitted at 20/40/60 chars, NOT at 80/120), which is why it looked
// exempt for so long. Both split.
const { test, expect } = require('@playwright/test');
const { splitTrailingCr, bracketLongBody, isEscapeKey, endsBracketedPaste, CR_FRAME } = require('../lib/submit-frames');
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

  // The images-only submit. The compose bar sends each staged image as its own
  // `ESC[200~<path>ESC[201~` frame; with no prompt text there is nothing left to carry the
  // CR clear of that close, so the submit goes out as a BARE CR microseconds behind it.
  // The TUI reads bytes, not frames — it folds the two together and eats the Enter, which
  // is why the image appeared on the terminal line and the turn never started.
  test('withholds a bare CR that lands on a still-open paste', () => {
    const s = splitTrailingCr(Buffer.from('\r'), { afterPasteClose: true });
    expect(s).not.toBeNull();
    expect(s.head.length).toBe(0);   // nothing to write now — only the CR, later
    expect(s.cr).toEqual(CR_FRAME);
  });

  test('an empty frame is never a submit', () => {
    expect(splitTrailingCr(Buffer.alloc(0))).toBeNull();
    expect(splitTrailingCr(Buffer.alloc(0), { afterPasteClose: true })).toBeNull();
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

// Which frame leaves a paste open behind it. This is the whole of the cross-frame rule:
// only a paste close can swallow a CR that arrives in the next frame, so only a paste
// close arms the withholding — ordinary typing never does, and a lone CR after `ls` still
// runs the command with no delay at all.
test.describe('endsBracketedPaste', () => {
  test('a frame ending in the paste close ends a paste', () => {
    expect(endsBracketedPaste(Buffer.from(`${ESC}[200~C:\\pics\\clip.png${ESC}[201~`))).toBe(true);
    expect(endsBracketedPaste(`${ESC}[201~`)).toBe(true);   // strings too — the worker writes both
  });

  test('ordinary typing, an open paste and a CR do not', () => {
    expect(endsBracketedPaste(Buffer.from('hello'))).toBe(false);
    expect(endsBracketedPaste(Buffer.from(`${ESC}[200~half typed`))).toBe(false); // still OPEN
    expect(endsBracketedPaste(Buffer.from('\r'))).toBe(false);
    expect(endsBracketedPaste(Buffer.from(`${ESC}[201~x`))).toBe(false);          // close, then more
  });

  test('empty and missing frames are not a paste close', () => {
    expect(endsBracketedPaste(Buffer.alloc(0))).toBe(false);
    expect(endsBracketedPaste('')).toBe(false);
    expect(endsBracketedPaste(null)).toBe(false);
    expect(endsBracketedPaste(undefined)).toBe(false);
  });

  test('a frame shorter than the close marker never matches', () => {
    expect(endsBracketedPaste(Buffer.from('~'))).toBe(false);
    expect(endsBracketedPaste(Buffer.from('01~'))).toBe(false);
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

// --- bracketLongBody: the OTHER half of the submit rule ----------------------
//
// #213 — a ~1500-character DICTATED prompt (reported 2026-09-02) looked complete in the compose
// box and arrived at the terminal as its tail alone. `buildComposeSubmission` brackets on
// one predicate — does the buffer contain a newline — and dictation emits none, so a
// dictated paragraph is the one long prompt still delivered to the TUI raw.
//
// Measured on the rig against claude 2.1.251 (scripts/rig/probe-paste-single-line.js,
// verdict from the transcript): unbracketed is whole at 288/488/988, NOT SUBMITTED once
// at 588, starts no turn at 1088, and at 1588 loses its first 1024 characters exactly,
// twice. Bracketed is whole at 588/1588/2588.
test.describe('bracketLongBody', () => {
  const LIMIT = agents.submitPolicy('claude').bracketAbove;
  const OPEN = ESC + '[200~';
  const CLOSE = ESC + '[201~';
  const long = (n) => 'x'.repeat(n);

  test('claude declares a threshold, under the measured 1024 cliff', () => {
    expect(typeof LIMIT).toBe('number');
    expect(LIMIT).toBeGreaterThan(0);
    // Strictly under the reproducible head-cut boundary, with room to spare — and under
    // 588, where the submit was lost on one run of two.
    expect(LIMIT).toBeLessThan(588);
  });

  test('wraps a long plain-text body in bracketed paste', () => {
    const out = bracketLongBody(Buffer.from(long(LIMIT + 1)), LIMIT);
    expect(out).not.toBeNull();
    const s = out.toString();
    expect(s.startsWith(OPEN)).toBe(true);
    expect(s.endsWith(CLOSE)).toBe(true);
    // The body itself must survive byte-for-byte — the whole point is losing nothing.
    expect(s.slice(OPEN.length, s.length - CLOSE.length)).toBe(long(LIMIT + 1));
  });

  // The regression guard for the report itself: a dictated paragraph has no newline, so
  // the client leaves it unbracketed and only this rule can save it.
  test('a newline-free 1500-char prompt — the reported case — is wrapped', () => {
    const dictated = 'so first we want to reflect the user if there is any problem '.repeat(25);
    expect(dictated).not.toContain('\n');
    expect(dictated.length).toBeGreaterThan(1024);
    const out = bracketLongBody(Buffer.from(dictated), LIMIT);
    expect(out).not.toBeNull();
    expect(out.toString()).toBe(OPEN + dictated + CLOSE);
  });

  test('leaves a body AT the threshold alone', () => {
    expect(bracketLongBody(Buffer.from(long(LIMIT)), LIMIT)).toBeNull();
  });

  test('leaves ordinary short input byte-identical — y, 1, continue', () => {
    for (const s of ['y', '1', 'continue', 'do it please']) {
      expect(bracketLongBody(Buffer.from(s), LIMIT)).toBeNull();
    }
  });

  // Undeclared means "never", which is exactly the behaviour every agent had before the
  // field existed. Codex and a plain shell both rely on it.
  test('no threshold declared = never wrapped, at any length', () => {
    expect(bracketLongBody(Buffer.from(long(99999)), undefined)).toBeNull();
    expect(bracketLongBody(Buffer.from(long(99999)), agents.submitPolicy('codex').bracketAbove)).toBeNull();
    expect(bracketLongBody(Buffer.from(long(99999)), agents.submitPolicy(null).bracketAbove)).toBeNull();
  });

  // REFUSED, never sanitised. A body carrying ESC is not plain text — it may already be a
  // bracketed paste, or an arrow key, or a live '/'-line's backspaces — and _pasteInner's
  // lesson is that stripping markers out of a body is no defence, since deleting the inner
  // open from `a ESC[2 ESC[200~ 01~ b` reconstitutes a close.
  test('refuses a body that already contains ESC — including one already bracketed', () => {
    expect(bracketLongBody(Buffer.from(OPEN + long(LIMIT + 1) + CLOSE), LIMIT)).toBeNull();
    expect(bracketLongBody(Buffer.from(long(LIMIT + 1) + ESC + '[A'), LIMIT)).toBeNull();
  });

  // SECURITY: the wrapper must not be escapable. A body carrying the paste CLOSE would
  // end the paste early, and everything after it would be TYPED at the prompt — with a
  // CR in that remainder, SUBMITTED. Refusing every ESC-bearing body is what makes that
  // unreachable, and it is why the gate refuses rather than STRIPS: _pasteInner shows
  // that deleting markers from a body can RECONSTITUTE one — removing the inner open
  // from `a ESC[2 ESC[200~ 01~ b` leaves `ESC[2` and `01~` adjacent, which IS a close.
  test('a body carrying the paste CLOSE cannot break out of the wrapper', () => {
    const attack = long(LIMIT + 1) + CLOSE + 'rm -rf /';
    expect(bracketLongBody(Buffer.from(attack), LIMIT)).toBeNull();
    // and the split-marker form the Dart comment warns about
    const split = long(LIMIT + 1) + ESC + '[2' + ESC + '[200~' + '01~';
    expect(bracketLongBody(Buffer.from(split), LIMIT)).toBeNull();
  });
  test('refuses a body containing CR or LF — the client already brackets multi-line', () => {
    expect(bracketLongBody(Buffer.from(long(LIMIT + 1) + '\n' + long(10)), LIMIT)).toBeNull();
    expect(bracketLongBody(Buffer.from(long(LIMIT + 1) + '\r' + long(10)), LIMIT)).toBeNull();
  });

  test('accepts a string as well as a Buffer, and preserves multi-byte text', () => {
    const hebrew = 'שלום עולם '.repeat(80); // > LIMIT in code units, 2 bytes per char in UTF-8
    expect(hebrew.length).toBeGreaterThan(LIMIT);
    const out = bracketLongBody(hebrew, LIMIT);
    expect(out).not.toBeNull();
    expect(out.toString('utf8')).toBe(OPEN + hebrew + CLOSE);
  });
});
