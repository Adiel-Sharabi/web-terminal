#!/usr/bin/env node
'use strict';
// The close-out answer (#469, docs/SUPERVISOR-DESIGN.md section 7), run by the AGENT inside a
// web-terminal session that reported done, when the Supervisor asks it to close out:
//
//   node scripts/wt-closeout.js clean
//   node scripts/wt-closeout.js blocked "<what is left that you cannot fix>"
//
// The answer is STATE, never prose (the #359 pattern): `clean` lets the Supervisor close a
// session an agent opened, or mark the owner's session ready to close; `blocked` puts it in
// front of the owner. Identity and credential: lib/session-post.js (the hook token).

const { postJson } = require('../lib/session-post');

const [state, ...rest] = process.argv.slice(2);
if (!['clean', 'blocked'].includes(state)) {
  console.error('usage: wt-closeout.js clean | blocked "<what is left that you cannot fix>"');
  process.exit(2);
}
postJson('wt-closeout', 'closeout', { state, left: rest.join(' ') }, (j) => {
  console.log(`close-out recorded: ${j.closeout && j.closeout.state}${j.closeout && j.closeout.left ? ` (${j.closeout.left})` : ''}`);
}).then((c) => process.exit(c));
