#!/usr/bin/env node
'use strict';
// The close-out answer (#469, docs/SUPERVISOR-DESIGN.md section 7), run by the AGENT inside a
// web-terminal session that reported done, when the Supervisor asks it to close out:
//
//   node scripts/wt-closeout.js clean
//   node scripts/wt-closeout.js clean --pr "<ref>" --owner <session id or name>
//   node scripts/wt-closeout.js blocked "<what is left that you cannot fix>"
//
// #543: clean means the session's subject is finished in full - merged, every PR it opened
// completed, reviews answered, leftovers only in a tracker item, nothing it started running.
// A PR SHARED with other sessions and still open: clean only by naming the ONE session that
// owns it (--pr, --owner); the Supervisor holds the close while that owner is not running.
//
// The answer is STATE, never prose (the #359 pattern): `clean` lets the Supervisor close a
// session an agent opened, or mark the owner's session ready to close; `blocked` puts it in
// front of the owner. Identity and credential: lib/session-post.js (the hook token).

const { postJson } = require('../lib/session-post');

// Quote the ref: an unquoted #9 starts a shell comment, and --pr then has no value.
const USAGE = 'usage: wt-closeout.js clean [--pr "<ref>" --owner <session>] | blocked "<what is left that you cannot fix>"';
const [state, ...rest] = process.argv.slice(2);
if (!['clean', 'blocked'].includes(state)) {
  console.error(USAGE);
  process.exit(2);
}
const body = { state, left: '' };
if (state === 'clean') {
  // Only the two flags, each with a value: anything else is refused here, nothing is sent.
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!['--pr', '--owner'].includes(k) || v === undefined || v.startsWith('--')) { console.error(USAGE); process.exit(2); }
    body[k.slice(2)] = v;
  }
} else body.left = rest.join(' ');
postJson('wt-closeout', 'closeout', body, (j) => {
  const r = j.closeout || {};
  console.log(`close-out recorded: ${r.state}${r.left ? ` (${r.left})` : ''}${r.owner ? ` (PR ${r.pr} is owned by ${r.owner})` : ''}`);
}).then((c) => process.exit(c));
