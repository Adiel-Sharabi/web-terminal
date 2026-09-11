'use strict';
// --- What the PTY was SHOWING when a session went cap-blocked (#228) ---------
//
// INSTRUMENTATION ONLY. Nothing in this file arms a timer, answers a selector,
// sets a status, or writes a byte into a terminal. It reads text that is already
// retained for other reasons and decides what may be written down about it. The
// declaration is made explicitly, the way lib/notification-shape.js makes its
// own: this runs at the exact instant #138's auto-resume machinery is taking a
// decision, and it must be obvious at a glance that it takes no part in it.
//
// THE ABSENCE IT EXISTS TO END. detectUsageLimitPromptInOutput (pty-worker.js)
// logs `usage-limit:` unconditionally the moment matchUsageLimitPrompt returns an
// answer. That string appears ZERO times in this fleet's worker log, which spans
// 2026-04-19 to 2026-09-11 and contains all three real 5h cap events - the
// `auto-resume:` lines for 2026-08-28, 2026-08-31 and the 2026-09-03 arm /
// 2026-09-04 fire are all present in the same file. Re-confirmed 2026-09-11 WITH A
// POSITIVE CONTROL, because a negative sweep that silently finds nothing confirms
// whatever you hoped for: the same grep finds `usage` 7 times in that file, none of
// them this line. Every arming on this box came from the metrics route instead.
// So four things could be true and nobody has looked:
//   1. the claude in use no longer renders the numbered selector #138 captured;
//   2. it renders, but does not survive pty-worker.js's stripAnsiForScan;
//   3. it survives, but MENU_OPTION_LINE's sibling-option rule does not hold;
//   4. the sessions were simply never in a state where it was drawn.
//
// THE ANSWER IS THREE FACTS, NOT A TEXT DUMP, and that ordering is the whole
// design. `sentenceInRaw` / `sentenceInStripped` / `matcherAnswer` separate all
// four cases between them: raw=false is (4) or a window too small; raw=true with
// stripped=false is (2) exactly; stripped=true with matcher=null is (1) or (3),
// which the per-line `opt` flags then tell apart - they report, line by line, what
// MENU_OPTION_LINE itself thought of that line. The redacted tail is
// CORROBORATION - what the screen looked like - and it is the only part of the
// output that can ever leak anything.
//
// AND `matcherAnswer` ANSWERS THE CARRY BY DIFFERENCE, which is the one question
// the text could never answer on its own. This runs the SAME rule through the SAME
// stripper as detectUsageLimitPromptInOutput, but over the whole retained tail
// instead of over one PTY read plus LIMIT_PROMPT_CARRY (512 bytes). So a sample
// reporting an answer for a session whose log carries no `usage-limit:` line says
// the bytes were matchable in aggregate and not as the detector met them - which
// leaves the read boundary and the carry, and nothing else. Reading the two
// together is the point; neither says it alone.
//
// RUNNING THE MATCHER HERE IS A READING, NOT AN ACTION. matchUsageLimitPrompt's
// own header explains why it is more than `pattern.test`: the worker answers a
// match by WRITING A KEYSTROKE, so a false positive types a digit into somebody's
// live composer, and this repo's own source was once a trigger phrase for exactly
// that reason. The answer is DISCARDED here - it reaches a log line and nothing
// else - so the two structural barriers are not being relied on for safety on this
// path at all. They are nevertheless left byte-identical, because loosening them
// is the one fix #228 rules out in bold.
//
// The rule lives in lib/ rather than in pty-worker.js for the reason every other
// pure rule in this repo does (lib/submit-frames.js, lib/agent-ready.js,
// lib/usage-limit.js): the worker is a process, not a module, so a rule inside it
// is reachable only by spawning a PTY - and a redaction rule is precisely the kind
// that has to be testable cheaply and often.

const { MENU_OPTION_LINE, matchUsageLimitPrompt } = require('./usage-limit');
const { redactNotificationMessage } = require('./notification-shape');

/// How much RAW scrollback the caller should hand in.
///
/// Escapes routinely outweigh text in a TUI stream - a repainted row carries an SGR
/// run per colour change - so a raw slice sized for the text budget would arrive
/// starved after stripping. Over-fetch 4x and let the strip decide how much text
/// that turns out to be. Same instinct as #178's "over-fetch so the anchor is inside
/// the slice", applied to a much simpler problem.
const CAP_RAW_CHARS = 4 * 64 * 1024;

/// How much of the STRIPPED tail is searched and censused.
///
/// A 120x30 screen is 3600 characters of text once the escapes are gone, so this is
/// about eighteen screens. Generous on purpose and effectively free: it is a slice
/// of a buffer the worker already retains (MAX_SCROLLBACK_SIZE is 2 MB), taken once
/// per cap transition. A selector that is on screen is being repainted, so it sits
/// in the newest bytes; the width is for the case where it is not.
const CAP_SCAN_CHARS = 64 * 1024;

/// How much of that window is actually written down.
///
/// One full 120x30 screen of text. Spent SYMMETRICALLY around the sentence when the
/// sentence is found, because the sibling-option rule reads the line ABOVE OR BELOW
/// - "stop and wait" is the last option in the reordered render, which is why
/// matchUsageLimitPrompt accepts a sibling on either side - so a window that only
/// looked backwards would fail to show half of what is being questioned.
const CAP_WINDOW_CHARS = 3600;

/// One written line, in characters of the ORIGINAL text.
///
/// A terminal row at the worker's default width. Longer lines are BROKEN, not
/// truncated - see _chunkLine, where the possibility that a stripped TUI stream
/// carries a whole screen on one line is itself a candidate answer to #228 and so
/// must not be the thing the budget throws away.
const CAP_LINE_CHARS = 120;

/// A ceiling on lines per sample, so a window of very short lines cannot become a
/// page of log. CAP_WINDOW_CHARS / CAP_LINE_CHARS is 30, so it normally does not
/// bind at all.
const CAP_MAX_LINES = 40;

/// How long before the same session may be sampled again.
///
/// The trigger is a TRANSITION into cap-blocked, which for a real cap event happens
/// once: isCapBlocked is monotone inside a window (spend only rises, and clampPct
/// rounds, so 99.5 already reads as 100) and stays true until CAP_BLOCK_GRACE_MS -
/// 10 minutes - past the resume moment. So what this guards is a flap around that
/// one boundary, not a repaint storm, and it is set just above that grace for
/// exactly that reason while staying far below the 5h window, so a genuine second
/// cap event in the same session is still captured. That is the same shape, and the
/// same trade, as LIMIT_PROMPT_COOLDOWN_MS next door in pty-worker.js.
///
/// Deliberately NOT lib/notification-shape.js's ordinal rule (noteDrop /
/// shouldLogDrop: first, then every hundredth). That one counts sightings of a
/// WORDING in an unbounded key space, and neither half fits here - the key space is
/// one entry per session, and "every hundredth transition" would in practice mean
/// "the first one ever", losing every later cap event on a worker that runs for
/// weeks. Reusing it would be a citation, not an SSOT.
const CAP_SAMPLE_COOLDOWN_MS = 15 * 60 * 1000;

/// Is a sample due for this session? `lastAt` is when it was last sampled, with
/// null/0/undefined meaning never.
function shouldSampleCapTail(lastAt, now, cooldownMs) {
  const cd = (typeof cooldownMs === 'number' && Number.isFinite(cooldownMs))
    ? cooldownMs : CAP_SAMPLE_COOLDOWN_MS;
  if (!lastAt) return true;
  return (now - lastAt) >= cd;
}

/// Break one over-long line into pieces AT WHITESPACE.
///
/// Two reasons it breaks rather than truncating. First, a TUI repaints by
/// POSITIONING the cursor, so a stripped stream need not carry a newline per screen
/// row - several rows can arrive as one very long line. If that is what is
/// happening then MENU_OPTION_LINE, which is ^-anchored, could never match, and
/// that IS one of the four candidate answers: a budget that silently dropped the
/// tail of such a line would destroy the evidence for the very hypothesis it was
/// collected to test. Second, redactNotificationMessage caps at 200 characters and
/// appends an ellipsis, so a single 3600-character line would have reached the log
/// as its first 200 characters and nothing else.
///
/// At whitespace, never mid-token, because redactNotificationMessage classifies
/// WHOLE tokens: half a filename is a token it has never seen, and half of
/// `secret.txt` can be a bare word. A run longer than `width` with no space in it is
/// hard-cut (there is nothing else to do) - the residual exposure is a fragment of
/// an unbroken 120-character run of letters, which is not a shape any secret takes.
function _chunkLine(line, width) {
  const out = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ +/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/// Everything worth knowing about one cap-blocked-with-no-sighting tail.
///
/// `rawTail` is the un-stripped PTY bytes; `cleanTail` is the SAME bytes after
/// pty-worker.js's stripAnsiForScan. The caller does the stripping on purpose: the
/// question is what THE DETECTOR sees, so the sample has to go through the
/// detector's own stripper rather than a second one that would answer a different
/// question (this repo already owns two - see lib/ansi.js and #192).
///
/// Everything structural is computed BEFORE redaction and everything written is
/// computed after. Redaction erases box-drawing glyphs and the selection caret
/// (they are outside the surviving character class), so a reader cannot recover the
/// menu's shape from the text - which is why `opt` is carried per line, measured on
/// the original.
function describeCapTail(rawTail, cleanTail, cfg, opts) {
  const o = opts || {};
  const scanChars = o.scanChars || CAP_SCAN_CHARS;
  const windowChars = o.windowChars || CAP_WINDOW_CHARS;
  const lineChars = o.lineChars || CAP_LINE_CHARS;
  const maxLines = o.maxLines || CAP_MAX_LINES;

  const raw = String(rawTail == null ? '' : rawTail).slice(-CAP_RAW_CHARS);
  const scan = String(cleanTail == null ? '' : cleanTail).slice(-scanChars);

  // A LOCAL, NON-GLOBAL COPY of the registry's pattern. lastIndex is mutable state
  // on a shared frozen object: `.test` on a /g regex advances it, so probing here
  // could change the answer the real detector gets next. The same statefulness
  // lib/notification-shape.js calls out for its own anchored regexes.
  const src = cfg && cfg.pattern instanceof RegExp ? cfg.pattern : null;
  const probe = src ? new RegExp(src.source, src.flags.replace(/[gy]/g, '')) : null;
  const sentenceInRaw = !!(probe && probe.test(raw));
  const hit = probe ? probe.exec(scan) : null;

  let optionLines = 0;
  for (const ln of scan.split(/\r?\n/)) if (MENU_OPTION_LINE.test(ln)) optionLines++;

  const start = hit
    ? Math.max(0, hit.index - Math.floor(windowChars / 2))
    : Math.max(0, scan.length - windowChars);
  const win = scan.slice(start, start + windowChars);

  const lines = [];
  for (const ln of win.split(/\r?\n/)) {
    if (!ln.trim()) continue;               // a blank row is furniture, not evidence
    const opt = MENU_OPTION_LINE.test(ln);
    for (const piece of _chunkLine(ln, lineChars)) {
      lines.push({ len: piece.length, opt, text: redactNotificationMessage(piece) });
    }
  }
  // Over budget: keep the middle when the window is anchored, the end when it is
  // not. The anchor is centred by CHARACTER and lines are uneven, so the middle of
  // the list is an approximation of it rather than the line itself - good enough for
  // a case the paragraph on CAP_MAX_LINES explains normally does not arise.
  if (lines.length > maxLines) {
    const from = hit ? Math.floor((lines.length - maxLines) / 2) : lines.length - maxLines;
    lines.splice(0, from);
    lines.length = maxLines;
  }

  return {
    rawChars: raw.length,
    strippedChars: scan.length,
    sentenceInRaw,
    sentenceInStripped: !!hit,
    optionLines,
    matcherAnswer: cfg ? matchUsageLimitPrompt(scan, cfg) : null,
    anchored: !!hit,
    lines,
  };
}

module.exports = {
  CAP_RAW_CHARS,
  CAP_SCAN_CHARS,
  CAP_WINDOW_CHARS,
  CAP_LINE_CHARS,
  CAP_MAX_LINES,
  CAP_SAMPLE_COOLDOWN_MS,
  shouldSampleCapTail,
  describeCapTail,
};
