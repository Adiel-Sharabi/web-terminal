// @ts-check
// #190 — the composer readiness marker is SPECIFIC, not just "a caret".
//
// #147 gates a submit on `readiness.composer` appearing in the PTY. That marker was
// the bare caret U+276F, and Claude's FOLDER-TRUST dialog draws the same glyph as its
// selection cursor — so the latch flipped on a session parked at a selector, the
// session was published ready, and the client was cleared to submit into it. The
// dialog's default row is `No, exit` and its footer is `Enter to confirm`, so the
// submit's trailing CR CONFIRMS EXIT and drops the agent back to bash: the words are
// not merely eaten, the agent is gone.
//
// Measured off a real PTY against claude 2.1.251 (scripts/rig/probe-trust-prompt.js):
// the composer writes the caret followed by U+00A0 NO-BREAK SPACE; the trust dialog
// writes the caret followed immediately by CHA (`ESC[4G`), because that dialog emits no
// spaces at all — it positions every word with CHA.
//
// WHY EVERY CHARACTER BELOW IS BUILT FROM A CODE POINT AND NEVER TYPED. A literal
// U+00A0 is invisible in a diff and gets normalised to an ordinary space in transit —
// observed repeatedly while writing the probe this spec came from. If that happens to
// the RULE and to a literal in this FILE at the same time, the positive assertion still
// passes, because both sides became ordinary spaces. **Only the negative assertion goes
// red.** That is why the negative case is the load-bearing half of this file, and why
// nothing here may be spelled with the character itself.
const { test, expect } = require('@playwright/test');
const { readinessMarker } = require('../lib/agents');
const { createReadyDetector, CARRY_BYTES } = require('../lib/agent-ready');

const CARET = String.fromCodePoint(0x276f);   // the composer caret / selector cursor
const NBSP = String.fromCodePoint(0x00a0);    // what the COMPOSER writes after it
const SP = String.fromCodePoint(0x0020);      // what a normalisation would leave behind
const ESC = String.fromCodePoint(0x001b);

// The trust dialog's real bytes, captured off the PTY. The caret is followed by CHA to
// column 4 — never by a space of any kind.
const TRUST_DIALOG = `${ESC}[2m${ESC}[38;2;177;185;249m${CARET}${ESC}[4GNo,${ESC}[8Gexit${ESC}[39m`;
// The composer's real bytes, same capture: rule line, caret, NBSP, dim placeholder.
const COMPOSER = `${ESC}[38;2;136;136;136m${'─'.repeat(8)}${ESC}[39m\r\n${CARET}${NBSP}${ESC}[2mTry${ESC}[7G"how`;

test.describe('#190 the claude composer readiness marker', () => {
  test('MATCHES the composer: caret + U+00A0', () => {
    expect(readinessMarker('claude').test(CARET + NBSP)).toBe(true);
    expect(readinessMarker('claude').test(COMPOSER)).toBe(true);
  });

  test('does NOT match caret + an ordinary space — the load-bearing case', () => {
    // If anything normalises U+00A0 to U+0020 anywhere between here and the registry,
    // THIS is the assertion that notices. The positive one above would still pass,
    // because both sides would have become ordinary spaces together.
    expect(readinessMarker('claude').test(CARET + SP)).toBe(false);
    // A resumed session REPLAYS its earlier turns, and the transcript renders a past
    // user prompt as caret + ordinary space. Measured. That is history being
    // reprinted, not a live composer, and it must not arm the latch.
    expect(readinessMarker('claude').test(`${CARET}${SP}reply with exactly one word`)).toBe(false);
  });

  test('does NOT match the trust dialog Claude actually draws', () => {
    expect(readinessMarker('claude').test(TRUST_DIALOG)).toBe(false);
  });

  test('does NOT match a bare shell prompt', () => {
    expect(readinessMarker('claude').test('adiel@host MINGW64 /c/dev/x\r\n$ ')).toBe(false);
    // The starship / pure / oh-my-posh hazard lib/agent-ready.js names: those themes
    // use the same glyph as a PS1, but with an ordinary space after it.
    expect(readinessMarker('claude').test(`${CARET}${SP}`)).toBe(false);
  });

  test('is STATELESS — a /g regex would silently skip every other match', () => {
    // `.test()` on a /g regex advances lastIndex, so the same detector would answer
    // true, then false, for identical input. The registry must never declare one.
    const re = readinessMarker('claude');
    expect(re.flags).toBe('');
    expect(re.test(CARET + NBSP)).toBe(true);
    expect(re.test(CARET + NBSP)).toBe(true);
  });

  test('survives being SPLIT across two PTY writes', () => {
    // 5 bytes (E2 9D AF C2 A0) against CARRY_BYTES, so this is safe by arithmetic —
    // but arithmetic is not a test, and a marker missed this way is missed FOREVER:
    // unlike the api-error sniff, the composer does not reprint it.
    const marker = Buffer.from(CARET + NBSP, 'utf8');
    expect(marker.length).toBe(5);
    expect(marker.length).toBeLessThanOrEqual(CARRY_BYTES);

    for (let cut = 1; cut < marker.length; cut++) {
      const d = createReadyDetector(readinessMarker('claude'));
      expect(d.push(Buffer.concat([Buffer.from('booting\r\n'), marker.subarray(0, cut)]))).toBe(false);
      expect(d.ready).toBe(false);
      expect(d.push(marker.subarray(cut))).toBe(true);
      expect(d.ready).toBe(true);
    }
  });

  test('a RESTORED session still latches', () => {
    // Getting this backwards would be worse than the bug being fixed: if a resumed
    // composer did not print the marker, the latch would never flip and every restored
    // session would be submit-blocked until the 45s fallback — on every cold restart,
    // including the one that deploys this change. Measured instead: `claude --resume`
    // prints it ~1.1s after the launch write, at 120 and at 52 columns.
    const d = createReadyDetector(readinessMarker('claude'));
    // The replayed history comes first, and carries the caret with an ORDINARY space.
    expect(d.push(`${CARET}${SP}reply with exactly the single word OK\r\n`)).toBe(false);
    expect(d.push('● OK\r\n')).toBe(false);
    expect(d.ready).toBe(false);
    // Then the live composer.
    expect(d.push(`${ESC}[38;2;136;136;136m${'─'.repeat(8)}${ESC}[39m\r\n${CARET}${NBSP}\r\n`)).toBe(true);
    expect(d.ready).toBe(true);
  });

  test('a failed --resume prints no caret at all, so the fallback still owns it', () => {
    // `claude --resume <missing-id>` prints one line and returns to the shell. Neither
    // the old marker nor the new one matches, so the 45s WT_READY_FALLBACK_MS ceiling
    // is what covers it — unchanged in width by this fix, which is the point.
    const failed = '$  claude --resume 00000000-0000-4000-8000-000000000000\r\n'
      + 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000\r\n'
      + 'adiel@host MINGW64 /c/dev/x\r\n$ ';
    expect(readinessMarker('claude').test(failed)).toBe(false);
    expect(/❯/.test(failed)).toBe(false);
  });
});
