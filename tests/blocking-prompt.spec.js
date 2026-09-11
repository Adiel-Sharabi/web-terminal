// @ts-check
// #190 - Claude's STARTUP SELECTOR FAMILY: the pure rules.
//
// The mechanism and the capture live in lib/blocking-prompt.js's header. What this
// file pins is the part a future edit can silently break:
//
//   * the render, because the dialog emits NO SPACES and a stripped stream is
//     unreadable - the matcher is worthless without it;
//   * the three shape gates, each MUTATED ONE AT A TIME. #249's review lesson: two
//     gates removed together prove nothing about either, and a negative fixture drawn
//     faithfully from real data is the one most likely to pass because a DIFFERENT
//     guard fired first;
//   * that this repo's own source cannot trigger it (#138's rule - the detector's
//     match causes a KEYSTROKE, and #138's phrase in a comment made a Claude session
//     that `cat`'d the file type a digit into its own composer);
//   * that the answer is read off the RENDER, since the default row is `No, exit` and
//     a fixed key sequence against a reordered render would kill the agent.
//
// EVERY control and non-ASCII character here is BUILT, never typed - the same rule as
// tests/composer-marker.spec.js, and for the same reason: an escape written through an
// editing channel arrives as a literal, and if that hits the rule and a literal in this
// file together, the positive assertions still pass. The negatives are load-bearing.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { matchBlockingPrompt, renderColumns, renderLine } = require('../lib/blocking-prompt');
const { blockingPromptsFor } = require('../lib/agents');

const ESC = String.fromCodePoint(0x001b);
const CARET = String.fromCodePoint(0x276f);
const CR = String.fromCodePoint(0x000d);
const DOWN = ESC + '[B';
const UP = ESC + '[A';

const CFG = blockingPromptsFor('claude');

/** CHA to column n. */
const at = (n) => `${ESC}[${n}G`;
/** An SGR run, of the kind Claude wraps every word of this dialog in. */
const sgr = `${ESC}[38;2;177;185;249m`;
const off = `${ESC}[39m`;

// The trust dialog's REAL bytes, captured off a live PTY (claude 2.1.268, 2026-09-11,
// scripts/rig/probe-trust-prompt.js capture, with WT_TRUST_PROBE_PARENT pointed at a
// directory with no trusted ancestor). Every word positioned with CHA; not one space.
const TRUST_LINES = [
  `${at(2)}${ESC}[38;2;255;193;7m${ESC}[1mAccessing${at(12)}workspace:${ESC}[22m${off}`,
  '',
  `${at(2)}${ESC}[1mC:${String.fromCodePoint(0x5c)}temp${String.fromCodePoint(0x5c)}probe${ESC}[22m`,
  '',
  `${at(2)}Quick${at(8)}safety${at(15)}check:${at(22)}Is${at(25)}this${at(30)}a${at(32)}project${at(40)}you${at(44)}created${at(52)}or${at(55)}one${at(59)}you${at(63)}trust?`,
  '',
  `${at(2)}${ESC}[38;2;153;153;153mSecurity${at(11)}guide${off}`,
  '',
  `${at(2)}${sgr}${CARET}${at(4)}No,${at(8)}exit${off}`,
  `${at(4)}Yes,${at(9)}I${at(11)}trust${at(17)}this${at(22)}folder`,
  '',
  `${at(2)}${ESC}[38;2;153;153;153mEnter${at(8)}to${at(11)}confirm${at(19)}.${at(21)}Esc${at(25)}to${at(28)}cancel${off}`,
];
const TRUST = TRUST_LINES.join('\r\n');

test.describe('#190 renderColumns - the dialog emits NO SPACES', () => {
  test('CHA is honoured as padding, so the words come back apart', () => {
    const out = renderColumns(TRUST);
    // THE WHOLE POINT. Without the render these read `Yes,Itrustthisfolder` and
    // `Quicksafetycheck:Isthis...`, and no sentence a human could write would match.
    expect(out).toContain('Yes, I trust this folder');
    expect(out).toContain('Quick safety check: Is this a project you created or one you trust?');
    expect(out).toContain('Enter to confirm');
  });

  test('a naive strip CANNOT read it - the negative that justifies the render', () => {
    // If this ever passes, the dialog started emitting real spaces and the whole
    // module is solving a problem that no longer exists. That is worth knowing.
    const naive = TRUST.replace(new RegExp(ESC + String.fromCodePoint(0x5c) + '[[0-9;]*[A-Za-z]', 'g'), '');
    expect(naive).not.toContain('Yes, I trust this folder');
    expect(naive).toContain('Yes,Itrustthisfolder');
  });

  test('a line with no CHA is left alone but still stripped', () => {
    expect(renderLine(`${sgr}plain text${off}`)).toBe('plain text');
    expect(renderLine('')).toBe('');
  });
});

test.describe('#190 matchBlockingPrompt - the real dialog', () => {
  test('recognises the captured trust dialog and reads its options', () => {
    const hit = matchBlockingPrompt(TRUST, CFG);
    expect(hit).not.toBeNull();
    expect(hit.options).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(hit.cursor).toBe(0);
  });

  test('the keys are READ OFF THE RENDER, not assumed', () => {
    const hit = matchBlockingPrompt(TRUST, CFG);
    expect(hit.id).toBe('folder-trust');
    expect(hit.target).toBe(1);
    // One row down from the cursor, then confirm. Matches the sequence measured to
    // answer it (`probe-trust-prompt.js drive`: down-enter).
    expect(hit.keys).toEqual([DOWN, CR]);
  });

  test('a REORDERED render moves the keys with it - and would be fatal if it did not', () => {
    // The same dialog with the rows swapped and the cursor on the destructive one is
    // still answered correctly. A hardcoded "press Down then Enter" would here select
    // `No, exit` and kill the agent - which is why `answer: '1'`-style constants and
    // fixed sequences are both refused. Synthetic on purpose: no render like this has
    // been observed, and that is exactly why a test has to stand in for the rig.
    const swapped = [...TRUST_LINES];
    swapped[8] = `${at(2)}${sgr}${CARET}${at(4)}Yes,${at(9)}I${at(11)}trust${at(17)}this${at(22)}folder${off}`;
    swapped[9] = `${at(4)}No,${at(8)}exit`;
    const hit = matchBlockingPrompt(swapped.join('\r\n'), CFG);
    expect(hit.options).toEqual(['Yes, I trust this folder', 'No, exit']);
    expect(hit.cursor).toBe(0);
    expect(hit.target).toBe(0);
    expect(hit.keys).toEqual([CR]);            // already highlighted: just confirm
  });

  test('the cursor BELOW its sibling still resolves, upward', () => {
    const below = [...TRUST_LINES];
    below[8] = `${at(4)}No,${at(8)}exit`;
    below[9] = `${at(2)}${sgr}${CARET}${at(4)}Never,${at(11)}thanks${off}`;
    // `Never, thanks` is not a known member, so the family is reported with no answer -
    // the safe half of the two tiers, and the shape still resolved with the cursor last.
    const hit = matchBlockingPrompt(below.join('\r\n'), CFG);
    expect(hit.options).toEqual(['No, exit', 'Never, thanks']);
    expect(hit.cursor).toBe(1);
    expect(hit.keys).toBeNull();
  });
});

test.describe('#190 the shape gates - MUTATED ONE AT A TIME', () => {
  // Each case removes exactly ONE gate's input from the captured dialog and asserts
  // the match is gone. Removing two together is the #249 trap: the suite stays green
  // while one of the two lines could be deleted outright.

  test('gate 1 - the caret must have a CHA HARD against it', () => {
    const spaced = [...TRUST_LINES];
    // Caret then an ordinary space instead of CHA. Everything else is untouched: the
    // sibling row, the footer and all the wording are still exactly right.
    spaced[8] = `${at(2)}${sgr}${CARET} No, exit${off}`;
    expect(matchBlockingPrompt(spaced.join('\r\n'), CFG)).toBeNull();
  });

  test('gate 2 - a LONE option is prose, not a selector', () => {
    const lonely = [...TRUST_LINES];
    lonely[9] = '';                              // drop the sibling row only
    expect(matchBlockingPrompt(lonely.join('\r\n'), CFG)).toBeNull();
  });

  test('gate 2 - a neighbour at a DIFFERENT column is not a sibling', () => {
    const skewed = [...TRUST_LINES];
    skewed[9] = `${at(9)}Yes,${at(14)}I${at(16)}trust${at(22)}this${at(27)}folder`;
    expect(matchBlockingPrompt(skewed.join('\r\n'), CFG)).toBeNull();
  });

  test('gate 3 - no commit affordance, nothing to answer', () => {
    const mute = [...TRUST_LINES];
    mute[11] = `${at(2)}${ESC}[38;2;153;153;153mesc${at(6)}to${at(9)}interrupt${off}`;
    expect(matchBlockingPrompt(mute.join('\r\n'), CFG)).toBeNull();
  });

  test('gate 3 - the footer must be NEAR the options, not anywhere on screen', () => {
    const far = [...TRUST_LINES];
    far.splice(11, 0, '', '', '', '', '');       // push the footer past FOOTER_WINDOW
    expect(matchBlockingPrompt(far.join('\r\n'), CFG)).toBeNull();
  });

  test('all three gates present is what MATCHES - the positive control', () => {
    // The mutations above are only evidence if the unmutated fixture matches. Without
    // this the five negatives could all be passing for some unrelated reason.
    expect(matchBlockingPrompt(TRUST_LINES.join('\r\n'), CFG)).not.toBeNull();
  });
});

test.describe('#190 it cannot fire on this repo (#138s rule)', () => {
  // #138 is the precedent and the reason this matters: its captured sentence sat in a
  // lib/agents.js comment, so a Claude session that merely READ that file matched and
  // typed a digit into its own composer. A match here causes ARROW KEYS AND A CR on a
  // selector whose default row is `No, exit`.
  const SOURCES = [
    'lib/blocking-prompt.js',
    'lib/agents.js',
    'docs/CONFIGURATION.md',
    'tests/blocking-prompt.spec.js',
    'scripts/rig/probe-trust-prompt.js',
  ];

  for (const rel of SOURCES) {
    test(`reading ${rel} does not trigger it`, () => {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(matchBlockingPrompt(text, CFG)).toBeNull();
    });
  }

  test('and the reason is structural, not luck: no source file holds caret+ESC', () => {
    // The claim the header makes. If a capture is ever checked in, or a literal ESC
    // reaches a tracked file, THIS is what notices - and it names the mechanism rather
    // than re-asserting the outcome above.
    for (const rel of SOURCES) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(text.includes(CARET + ESC), `${rel} holds caret+ESC`).toBe(false);
    }
  });

  test('a QUOTED dialog in prose is still not a dialog', () => {
    // What a README, a comment or a chat transcript looks like: the right words, the
    // right layout, laid out with real spaces. This is the shape #138 was fooled by.
    const quoted = [
      '  Quick safety check: Is this a project you created or one you trust?',
      `  ${CARET} No, exit`,
      '    Yes, I trust this folder',
      '  Enter to confirm . Esc to cancel',
    ].join('\n');
    expect(matchBlockingPrompt(quoted, CFG)).toBeNull();
  });
});

test.describe('#190 the registry decides who is scanned at all', () => {
  test('Codex and a plain shell declare nothing - undeclared means NEVER', () => {
    // The standing convention: Claude's behaviour is not evidence about Codex, its
    // startup dialogs have not been captured, and an unmeasured marker is what #143
    // shipped. A caret in a plain shell's output must never be read as an agent dialog.
    expect(blockingPromptsFor('codex')).toBeNull();
    expect(blockingPromptsFor(null)).toBeNull();
    expect(blockingPromptsFor('some-future-agent')).toBeNull();
    expect(matchBlockingPrompt(TRUST, null)).toBeNull();
    expect(matchBlockingPrompt(TRUST, blockingPromptsFor('codex'))).toBeNull();
  });

  test('only the ROW THAT WILL BE PRESSED is declared', () => {
    // Not a title, not the question - the label of the option the keys select. The
    // thing acted on is the thing matched.
    expect(CFG.known.map((k) => k.id)).toEqual(['folder-trust']);
    expect(CFG.known[0].accept.test('Yes, I trust this folder')).toBe(true);
    expect(CFG.known[0].accept.test('No, exit')).toBe(false);
  });
});

test.describe('#190 an UNKNOWN member is reported, never answered', () => {
  test('the family is recognised by shape with no keys at all', () => {
    // The external-CLAUDE.md imports selector is the sibling this covers. Its wording
    // is UNMEASURED (it appears only after trust is answered, and this box ran out of
    // console handles before it could be captured), so this fixture is SYNTHETIC and
    // stands for "any member we have not measured" rather than for that dialog.
    const unknown = [
      `${at(2)}Allow${at(8)}external${at(17)}CLAUDE.md${at(27)}file${at(32)}imports?`,
      '',
      `${at(2)}${sgr}${CARET}${at(4)}No,${at(8)}disable${at(16)}external${at(25)}imports${off}`,
      `${at(4)}Yes,${at(9)}allow${at(15)}them`,
      '',
      `${at(2)}Enter${at(8)}to${at(11)}confirm${at(19)}.${at(21)}Esc${at(25)}to${at(28)}cancel`,
    ].join('\r\n');
    const hit = matchBlockingPrompt(unknown, CFG);
    expect(hit).not.toBeNull();
    expect(hit.id).toBeNull();                 // not a member we know how to answer
    expect(hit.keys).toBeNull();               // ...so nothing is pressed
    expect(hit.options).toEqual(['No, disable external imports', 'Yes, allow them']);
  });
});

test.describe('#190 arrows are not an interrupt', () => {
  test('DOWN and UP are CSI sequences, so isEscapeKey cannot read them as Esc', () => {
    // lib/submit-frames.js reads a LONE 0x1b as an interrupt. A 3-byte CSI arrow is
    // not one, which is why answering a selector cannot be mistaken for stopping a
    // turn. Asserted against the real rule rather than by inspection.
    const { isEscapeKey } = require('../lib/submit-frames');
    expect(isEscapeKey(Buffer.from(DOWN, 'utf8'))).toBe(false);
    expect(isEscapeKey(Buffer.from(UP, 'utf8'))).toBe(false);
    expect(isEscapeKey(Buffer.from(ESC, 'utf8'))).toBe(true);
  });
});
