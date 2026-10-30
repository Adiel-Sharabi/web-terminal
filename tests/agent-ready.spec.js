// @ts-check
// #147 — the pure readiness latch (lib/agent-ready.js).
//
// A new session drops the user into the chat lens seconds before the agent CLI
// can accept anything: the PTY is still at the shell prompt, so a prompt sent in
// that window goes to BASH and the text is gone. Measured on the rig against
// claude 2.1.237 (scripts/rig/probe-claude-ready.js): submitted before the
// composer marker, NO turn started and bash answered "command not found";
// submitted after it, a turn started. The marker appeared at 5.0s on one run and
// 6.1s on the next — which is why this is a marker and not a timer.
const { test, expect } = require('@playwright/test');
const { createReadyDetector, CARRY_BYTES } = require('../lib/agent-ready');

const CARET = /❯/;

test.describe('lib/agent-ready.createReadyDetector', () => {
  test('an agent with NO declared marker is ready immediately', () => {
    // The load-bearing default. A plain shell IS usable at its first prompt, and
    // an agent we cannot recognise must never be gated behind a marker that will
    // never arrive — that is a session permanently unable to submit.
    for (const nothing of [null, undefined]) {
      const d = createReadyDetector(nothing);
      expect(d.ready).toBe(true);
      // Feeding it changes nothing and never reports a transition.
      expect(d.push('anything at all')).toBe(false);
      expect(d.ready).toBe(true);
    }
  });

  test('starts NOT ready and flips on the marker, reporting the edge once', () => {
    const d = createReadyDetector(CARET);
    expect(d.ready).toBe(false);

    expect(d.push('bash: still booting\n')).toBe(false);
    expect(d.ready).toBe(false);

    // The transition is reported exactly once, so the caller can log and
    // broadcast on it rather than de-duplicating downstream.
    expect(d.push('╭─────╮\n│ ❯   │\n')).toBe(true);
    expect(d.ready).toBe(true);
    expect(d.push('❯ again')).toBe(false);
    expect(d.ready).toBe(true);
  });

  test('a marker SPLIT across two chunks is still found', () => {
    // The caret is 3 UTF-8 bytes (E2 9D AF) and a PTY read can land anywhere.
    // Missing it is permanent — unlike the api-error phrase next door it does not
    // stay on screen and does not repeat — so a dropped match is a session that
    // never becomes ready at all.
    const caret = Buffer.from('❯', 'utf8');
    expect(caret).toHaveLength(3);

    const d = createReadyDetector(CARET);
    expect(d.push(caret.subarray(0, 2))).toBe(false);
    expect(d.ready).toBe(false);
    expect(d.push(caret.subarray(2))).toBe(true);
    expect(d.ready).toBe(true);
  });

  test('a split marker is found even with padding around the boundary', () => {
    const bytes = Buffer.from('prompt line ❯ ready', 'utf8');
    const cut = bytes.indexOf(0xe2) + 1; // mid-caret
    const d = createReadyDetector(CARET);
    expect(d.push(bytes.subarray(0, cut))).toBe(false);
    expect(d.push(bytes.subarray(cut))).toBe(true);
  });

  test('the carry cannot grow into a buffer of the whole stream', () => {
    const d = createReadyDetector(CARET);
    for (let i = 0; i < 50; i++) d.push('x'.repeat(4096));
    expect(d.ready).toBe(false);
    // Still matches straight after all that: the carry is a small OVERLAP, and
    // holding only the tail must not cost a match at the next boundary.
    expect(d.push('❯')).toBe(true);
    expect(CARRY_BYTES).toBeLessThanOrEqual(64);
  });

  test('force() is the safety net — ready without ever seeing the marker', () => {
    // An agent that fired a hook is self-evidently up whatever its screen did.
    // This is what makes a marker that changes in a future CLI release degrade to
    // "ready late" instead of "ready never" (#147: no stuck 'starting' state).
    const d = createReadyDetector(CARET);
    expect(d.ready).toBe(false);
    expect(d.force()).toBe(true);
    expect(d.ready).toBe(true);
    // Idempotent: a second forcing is not another transition to announce.
    expect(d.force()).toBe(false);
  });

  test('empty and null chunks are no-ops, never a false flip', () => {
    const d = createReadyDetector(CARET);
    expect(d.push(null)).toBe(false);
    expect(d.push(undefined)).toBe(false);
    expect(d.push('')).toBe(false);
    expect(d.push(Buffer.alloc(0))).toBe(false);
    expect(d.ready).toBe(false);
  });

  test('a bare ">" does NOT satisfy Claude\'s marker', () => {
    // Deliberate: `>` matches shell prompts, redirects and quoted output alike,
    // and a false positive here is the whole bug — it declares a session ready
    // while the PTY is still bash, which is exactly where prompts get eaten.
    const d = createReadyDetector(CARET);
    expect(d.push('adiel@Adiel-Home MINGW64 /c/dev $ ')).toBe(false);
    expect(d.push('echo hi > out.txt\n')).toBe(false);
    expect(d.ready).toBe(false);
  });
});

// #404 - Claude draws its composer before it has finished starting, then sends one more
// terminal query; a CR that lands before that query is dropped while the words stay in
// the composer. Measured with scripts/rig/probe-startup-cr.js (claude 2.1.314). The
// fixtures use the REGISTRY's markers, so a change to either is what these tests judge.
test.describe('lib/agent-ready - #404 the composer is not the end of startup', () => {
  const agents = require('../lib/agents');
  const COMPOSER = agents.readinessMarker('claude');
  const SETTLED = agents.readinessSettledMarker('claude');
  const ESC = String.fromCharCode(0x1b);
  const composer = String.fromCodePoint(0x276f, 0x00a0) + 'Try "fix lint errors"';
  const query = `${ESC}[>0q${ESC}[?u${ESC}]7501;?${String.fromCharCode(7)}`;

  test('Claude declares a settle marker, and it is the startup query', () => {
    expect(SETTLED).toBeInstanceOf(RegExp);
    expect(SETTLED.test(query)).toBe(true);
    // A different XT query is not it.
    expect(SETTLED.test(`${ESC}[0q`)).toBe(false);
    // Codex and a plain shell declare none: their readiness is unchanged.
    expect(agents.readinessSettledMarker('codex')).toBeNull();
    expect(agents.readinessSettledMarker(null)).toBeNull();
  });

  test('the composer ALONE is not ready; the query after it is', () => {
    const d = createReadyDetector(COMPOSER, SETTLED);
    expect(d.push(`banner\r\n${composer}\r\n`)).toBe(false);
    expect(d.composerSeen).toBe(true);
    expect(d.ready).toBe(false);
    expect(d.push('status line')).toBe(false);
    expect(d.push(query)).toBe(true);
    expect(d.ready).toBe(true);
    expect(d.push(query)).toBe(false); // the edge is reported once
  });

  test('a query BEFORE the composer does not count - Claude sends one before its banner too', () => {
    // The load-bearing negative: the production capture of the failed hand-off has the
    // query once before the banner. Counting it would declare ready at the composer,
    // which is the bug.
    const d = createReadyDetector(COMPOSER, SETTLED);
    expect(d.push(`${query}${ESC}[>4m banner`)).toBe(false);
    expect(d.push(composer)).toBe(false);
    expect(d.ready).toBe(false);
    // And one carried across the boundary is not retroactively counted either.
    const e = createReadyDetector(COMPOSER, SETTLED);
    expect(e.push(`${ESC}[>0q`)).toBe(false);
    expect(e.push(composer)).toBe(false);
    expect(e.ready).toBe(false);
  });

  test('composer and query in ONE read: ready at once, but only for the query AFTER it', () => {
    expect(createReadyDetector(COMPOSER, SETTLED).push(`${composer}\r\n${query}`)).toBe(true);
    expect(createReadyDetector(COMPOSER, SETTLED).push(`${query}\r\n${composer}`)).toBe(false);
  });

  test('a query SPLIT across reads after the composer is still found', () => {
    const d = createReadyDetector(COMPOSER, SETTLED);
    d.push(composer);
    expect(d.push(`x${ESC}[>`)).toBe(false);
    expect(d.push('0q')).toBe(true);
  });

  test('no settle marker declared: the composer alone is ready, as before', () => {
    const d = createReadyDetector(COMPOSER, null);
    expect(d.push(composer)).toBe(true);
  });

  test('force() still releases a session waiting to settle', () => {
    const d = createReadyDetector(COMPOSER, SETTLED);
    d.push(composer);
    expect(d.force()).toBe(true);
    expect(d.ready).toBe(true);
  });
});
