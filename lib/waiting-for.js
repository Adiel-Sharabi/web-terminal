'use strict';
// WHAT a blocked session is waiting for (#79) — decided once, server-side.
//
// WHY THIS EXISTS. `waiting` already means "blocked on the user", and the session list
// and status dot have always shown it. The chat lens showed nothing at all, and for this
// particular status that is uniquely bad: for `waiting`, SILENCE IS THE DEFINING
// CONDITION — the session is blocked and will emit no further turn, by design, until it
// is answered. So "no new turns in the transcript" is exactly what a stuck session looks
// like, and it is indistinguishable from one that simply went quiet. The user had to
// switch to the terminal lens to find out which.
//
// WHY IT IS DERIVED HERE AND NOT IN EACH CLIENT. Two clients render this lens
// (app.html and the companion) and a third consumer is the cluster merge. A client that
// re-derived "is something waiting" by scraping its own transcript copy would be a
// second source of truth for a fact the server already knows, and would disagree with
// the status dot beside it — the very disagreement this issue is about.
//
// WHY IT IS NOT AGENT-SPECIFIC. The two kinds are a property of what was captured, not
// of who is running: a structured question is one we actually recorded (Claude's
// AskUserQuestion, seen by the PreToolUse hook); anything else that blocks is a
// permission request — which is precisely what a Codex approval becomes when its OSC 9
// notification is applied through handleHook. So no provider field and no branch: a
// Codex approval and a Claude permission prompt are the same answer for the same reason.

/** A structured question we captured and can render natively (#19's overlay). */
const QUESTION = 'question';
/** Anything else that blocks the session on the user — permission / approval prompts. */
const PERMISSION = 'permission';

/**
 * @param {string|null|undefined} status        the session's worker-owned status
 * @param {boolean} hasPendingQuestion          a live AskUserQuestion was captured
 * @returns {'question'|'permission'|null}       null unless genuinely blocked
 *
 * Returns null — not 'none' — for every non-blocked status, so a client can render on
 * truthiness alone and can never accidentally show a banner for an idle session.
 */
function waitingFor(status, hasPendingQuestion) {
  if (status !== 'waiting') return null;
  return hasPendingQuestion ? QUESTION : PERMISSION;
}

module.exports = { waitingFor, QUESTION, PERMISSION };
