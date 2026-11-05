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
    // ONE key: one row down toward the accepted row. The CR is NOT planned here - it
    // goes out only once a redraw shows the highlight ON that row (#430, below).
    expect(hit.key).toBe(DOWN);
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
    expect(hit.key).toBe(CR);                 // already highlighted: just confirm
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
    expect(hit.key).toBeNull();
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
    expect(CFG.known.map((k) => k.id)).toEqual(['folder-trust', 'external-imports']);
    expect(CFG.known[0].accept.test('Yes, I trust this folder')).toBe(true);
    expect(CFG.known[0].accept.test('No, exit')).toBe(false);
    expect(CFG.known[1].accept.test('Yes, allow external imports')).toBe(true);
    expect(CFG.known[1].accept.test('No, disable external imports')).toBe(false);
  });
});

test.describe('#190 an UNKNOWN member is reported, never answered', () => {
  test('the family is recognised by shape with no keys at all', () => {
    // A look-alike of the external-imports selector whose accept row is NOT the
    // measured label (#430 measured `Yes, allow external imports`). It stands for
    // "any member we have not measured": reported, and nothing pressed.
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
    expect(hit.key).toBeNull();                // ...so nothing is pressed
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

test.describe('#190 the auto-answer DEFAULT is pinned, not merely exercised', () => {
  test('AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT is false', () => {
    // FOUND IN REVIEW OF PR #256, and it is the vacuous-negative trap in a new place.
    // `tests/worker-blocking-prompt.spec.js` has a case named "auto-answer OFF (the
    // default)" - but it FORCES `WT_AUTO_ANSWER_BLOCKING_PROMPT: '0'`, so it proves the
    // env override works and says nothing about the constant. Flip the constant to
    // `true` and the whole suite stays green.
    //
    // That is worth one line because of WHAT the default authorises: turning it on
    // presses "Yes, I trust this folder" for a directory chosen by whatever created the
    // session, and folder trust is the gate on the agent reading, editing and EXECUTING
    // what is in it - inherited by every descendant, recorded in ~/.claude.json, and
    // persisting after the session ends. A security-relevant default that no test pins
    // is a default that can move in a refactor nobody reads twice.
    const { AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT } = require('../lib/blocking-prompt');
    expect(AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// #430 - the answer is a LOOP: one key, then look again.
//
// MEASURED on the rig (claude 2.1.318, 2026-11-06): the worker's old plan - Down, then
// CR 600 ms later, both decided off the first render - exited the agent 3 runs of 3.
// A key landing inside Claude's startup window moves the highlight and is then UNDONE
// by a redraw with the caret back on `No, exit`, which the scheduled CR confirmed.
// The fixtures below mirror the measured byte STRUCTURE (in-place redraws joined by
// relative cursor moves; the erase run that follows a CR; the exit to a shell), built
// from code points like everything else here. No capture is checked in.
// ---------------------------------------------------------------------------------

const LF = String.fromCodePoint(0x000a);
const BEL = String.fromCodePoint(0x0007);
/** CUU/CUD/CUF/CUB - relative moves, which end a redrawn label. */
const mv = (n, f) => `${ESC}[${n}${f}`;

/** The dialog's own trailing bytes after a full render: park the cursor, print nothing. */
const AFTER_RENDER = `${CR}${LF}${mv(1, 'C')}${mv(4, 'A')}`;

/** Measured: the highlight moved to `Yes` - two rows rewritten on ONE line. */
const REDRAW_ON_YES = `${mv(1, 'D')}${mv(4, 'B')}${CR}${mv(1, 'C')}${mv(4, 'A')} ${at(4)}No, exit`
  + `${CR}${mv(1, 'C')}${mv(1, 'B')}${sgr}${CARET}${at(4)}Yes, I trust this folder${off}`
  + `${CR}${LF}${LF}${LF}${mv(1, 'C')}${mv(3, 'A')}`;

/** Measured ~150 ms after a key sent inside the startup window: the highlight is BACK. */
const REDRAW_RESET = `${mv(1, 'D')}${mv(3, 'B')}${mv(1, 'C')}${mv(4, 'A')}${sgr}${CARET}${at(4)}No, exit`
  + `${mv(1, 'C')}${mv(1, 'B')}${off} ${at(4)}Yes, I trust this folder`
  + `${CR}${LF}${LF}${LF}${mv(1, 'C')}${mv(4, 'A')}`;

/** Claude's startup query round, sent in the same millisecond as the dialog. Prints nothing. */
const STARTUP_QUERIES = `${ESC}[>0q${ESC}[?u${ESC}]7501;?${BEL}${ESC}[c`;

/** What answering does to the dialog before the next screen: erase every row. */
const ERASED = `${mv(1, 'D')}${mv(3, 'B')}` + `${ESC}[2K${mv(1, 'A')}`.repeat(12) + `${ESC}[G`;

/** The agent is gone: its exit sequences, then a shell prompt. Generic names only. */
const SHELL_PROMPT = `${ESC}[>4m${ESC}[<u${ESC}[?2004l${ESC}(B${ESC}7${ESC}[r${ESC}8`
  + `${CR}${LF}${ESC}]0;MINGW64:/c/x${BEL}${CR}${LF}${ESC}[32muser@host ${ESC}[33m/c/x${ESC}[0m${CR}${LF}$ `;

/** The external-imports member, measured structure: caret at col 3, labels at col 5. */
const IMPORTS_LINES = [
  `${at(3)}${ESC}[1mAllow${at(9)}external${at(18)}CLAUDE.md${at(28)}file${at(33)}imports?${ESC}[22m`,
  '',
  `${at(3)}${sgr}${CARET}${at(5)}No,${at(9)}disable${at(17)}external${at(26)}imports${off}`,
  `${at(5)}Yes,${at(10)}allow${at(16)}external${at(25)}imports`,
  '',
  `${at(3)}${ESC}[38;2;153;153;153mEnter${at(9)}to${at(12)}confirm${at(20)}.${at(22)}Esc${at(26)}to${at(29)}cancel${off}`,
];
const IMPORTS = IMPORTS_LINES.join(CR + LF);

test.describe('#430 the CR goes out only against a highlight the screen SHOWS', () => {
  test('the dialog with only the startup queries after it is LIVE and wants Down', () => {
    // Positive control for `live`: the query round prints nothing, so without this the
    // first key could never be pressed and every negative below would pass vacuously.
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + STARTUP_QUERIES, CFG);
    expect(hit.live).toBe(true);
    expect(hit.cursor).toBe(0);
    expect(hit.key).toBe(DOWN);
  });

  test('an in-place redraw onto Yes is read as the highlight, and THEN the CR', () => {
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + STARTUP_QUERIES + REDRAW_ON_YES, CFG);
    expect(hit.options).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(hit.cursor).toBe(1);
    expect(hit.live).toBe(true);
    expect(hit.key).toBe(CR);
  });

  test('NEGATIVE - the measured RESET redraw after it gets another Down, NEVER the CR', () => {
    // The exact failure: the arrow landed, then the dialog redrew with the caret back on
    // `No, exit`. A CR here exits the agent. Reading the highlight off the FIRST caret
    // (the full render) would also say row 0 here, so the positive test above is what
    // proves the LAST redraw is read; this one proves a reset is never confirmed.
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + REDRAW_ON_YES + REDRAW_RESET, CFG);
    expect(hit.cursor).toBe(0);
    expect(hit.key).toBe(DOWN);
  });

  test('NEGATIVE - a highlight whose label is not an option presses nothing', () => {
    const odd = `${CR}${mv(1, 'C')}${mv(1, 'B')}${sgr}${CARET}${at(4)}Yes, I trust this folder and its parent${off}${CR}${LF}`;
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + odd, CFG);
    expect(hit.cursor).toBe(-1);
    expect(hit.key).toBeNull();
  });
});

test.describe('#430 nothing is pressed into a dialog that is no longer on screen', () => {
  test('NEGATIVE - the agent exited to its shell: not live, no key', () => {
    // Office, 2026-11-05: the agent had exited, the report stayed, and the carry still
    // matched - so ten minutes later the worker typed Down + CR into bash.
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + REDRAW_RESET + SHELL_PROMPT, CFG);
    expect(hit).not.toBeNull();                // still REPORTED: the carry holds it
    expect(hit.live).toBe(false);
    expect(hit.key).toBeNull();
  });

  test('NEGATIVE - an erase on the SAME line as the redraw (no LF first) is still seen', () => {
    // `live` must read the rest of the update's own line, not only the lines after it.
    const sameLine = REDRAW_ON_YES.slice(0, REDRAW_ON_YES.indexOf(CR + LF)) + `${ESC}[2K${mv(1, 'A')}${ESC}[2K`;
    expect(matchBlockingPrompt(TRUST + AFTER_RENDER + sameLine, CFG).key).toBeNull();
    // ...and the same line WITHOUT the erase is live: the sibling row redrawn on it is
    // part of the dialog, so this negative is not passing on that.
    const plain = REDRAW_ON_YES.slice(0, REDRAW_ON_YES.indexOf(CR + LF));
    expect(matchBlockingPrompt(TRUST + AFTER_RENDER + plain, CFG).key).toBe(CR);
  });

  test('NEGATIVE - the dialog was ERASED after its CR: no second CR into the next screen', () => {
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + REDRAW_ON_YES + ERASED, CFG);
    expect(hit.cursor).toBe(1);                // the highlight WAS on Yes...
    expect(hit.live).toBe(false);              // ...but the dialog is gone
    expect(hit.key).toBeNull();
  });
});

test.describe('#430 the external-imports member', () => {
  test('recognised and answered - one Down toward `Yes, allow external imports`', () => {
    const hit = matchBlockingPrompt(IMPORTS + AFTER_RENDER, CFG);
    expect(hit.id).toBe('external-imports');
    expect(hit.options).toEqual(['No, disable external imports', 'Yes, allow external imports']);
    expect(hit.target).toBe(1);
    expect(hit.key).toBe(DOWN);
  });

  test('NEGATIVE - a look-alike accept row is reported, never answered', () => {
    const lookalike = [...IMPORTS_LINES];
    lookalike[3] = `${at(5)}Yes,${at(10)}allow${at(16)}external${at(25)}imports${at(33)}everywhere`;
    const hit = matchBlockingPrompt(lookalike.join(CR + LF) + AFTER_RENDER, CFG);
    expect(hit).not.toBeNull();
    expect(hit.id).toBeNull();
    expect(hit.key).toBeNull();
  });

  test('NEGATIVE - a look-alike trust row is reported, never answered', () => {
    const lookalike = [...TRUST_LINES];
    lookalike[9] = `${at(4)}Yes,${at(9)}I${at(11)}trust${at(17)}this${at(22)}folder${at(29)}and${at(33)}its${at(37)}parents`;
    const hit = matchBlockingPrompt(lookalike.join(CR + LF) + AFTER_RENDER, CFG);
    expect(hit).not.toBeNull();
    expect(hit.id).toBeNull();
    expect(hit.key).toBeNull();
  });

  test('the LAST dialog in the carry is the one on screen - trust answered, imports next', () => {
    // The carry is 4 KB, so it still holds the trust dialog when the imports one is
    // drawn below it. Taking the FIRST match would answer trust again - a CR read off a
    // highlight that is no longer on screen.
    const hit = matchBlockingPrompt(TRUST + AFTER_RENDER + REDRAW_ON_YES + ERASED + IMPORTS + AFTER_RENDER, CFG);
    expect(hit.id).toBe('external-imports');
    expect(hit.cursor).toBe(0);
    expect(hit.live).toBe(true);
    expect(hit.key).toBe(DOWN);
  });
});
