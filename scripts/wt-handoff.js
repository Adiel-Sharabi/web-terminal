#!/usr/bin/env node
'use strict';
// Post this session's hand-off verdict (#340).
//
// Run by the AGENT, only when web-terminal's hand-off prompt asks for it
// (lib/handoff.js wrapUpPrompt), after it has written the brief file the prompt named:
//
//   node scripts/wt-handoff.js <<'EOF'
//   {"canClose": true, "why": "everything is committed and pushed"}
//   EOF
//
// canClose false = closing this session now would lose something (uncommitted or
// unpushed work, a worktree only it knows about); the server then starts the successor
// but keeps this session open. Transport and credential: lib/session-post.js.

const { postFromStdin } = require('../lib/session-post');

postFromStdin('wt-handoff', 'handoff-report', (j) => {
  console.log(`hand-off verdict received (${j.canClose ? 'can close' : 'will be kept open'}). `
    + 'A fresh session is starting from your brief; this session needs nothing more.');
}).then((c) => process.exit(c));
