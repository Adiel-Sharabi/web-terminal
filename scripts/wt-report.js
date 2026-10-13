#!/usr/bin/env node
'use strict';
// Report this session's work to the web-terminal sessions dashboard (#298).
//
// Run by the AGENT inside a web-terminal session; the exact command is handed to it
// on every prompt (lib/session-brief.js reportCommand), so nobody types this by hand:
//
//   node scripts/wt-report.js <<'EOF'
//   {"items":[{"ref":"#123","title":"short title","state":"in-progress","note":"optional"}],"headline":"optional"}
//   EOF
//
// Session identity, credential and transport: lib/session-post.js (shared with
// scripts/wt-handoff.js). A validation error is printed as the server wrote it, for the
// agent to read and fix; the exit code says whether the dashboard took the report.

const { postFromStdin } = require('../lib/session-post');

postFromStdin('wt-report', 'report', (j) => {
  const n = (j.brief && j.brief.items && j.brief.items.length) || 0;
  const w = j.brief && j.brief.wait;
  console.log(`dashboard updated: ${n} work item${n === 1 ? '' : 's'}${w ? `; waiting on ${w.on}${w.what ? `: ${w.what}` : ''}` : ''}`);
}).then((c) => process.exit(c));
