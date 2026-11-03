#!/usr/bin/env node
'use strict';
// What web-terminal knows about one work item, across the cluster (#413) - the starting
// point of a `continue ado:<id>` prompt. Run by the AGENT inside a web-terminal session:
//
//   node scripts/wt-work-item.js ado:25309        # the resume note, as plain text
//   node scripts/wt-work-item.js ado:25309 --json # the whole view
//
// It prints every session that touched the item (machine, when, how its work ended), the
// newest snapshot (state, headline, last turn) and the hand-off brief when one is still on
// disk. It does not read the tracker: the item's card in Azure DevOps is the card writer's
// (the configured `workItemHook` command), so read that too.
// Identity and credential: lib/session-post.js (WT_SESSION_ID, WT_SESSION_PORT, WT_HOOK_TOKEN).

const { getFromSession } = require('../lib/session-post');

const ref = process.argv[2];
const asJson = process.argv.includes('--json');
if (!ref || ref.startsWith('-')) {
  console.error('usage: node scripts/wt-work-item.js <ado:123 | #123 | owner/repo#123> [--json]');
  process.exit(2);
}
getFromSession(`work-item/${encodeURIComponent(ref)}`).then((r) => {
  if (r.error) { console.error(`wt-work-item: ${r.error}`); return process.exit(1); }
  if (r.status !== 200) { console.error(`wt-work-item: the server refused it (HTTP ${r.status}): ${r.json.error || ''}`); return process.exit(1); }
  console.log(asJson ? JSON.stringify(r.json, null, 2) : r.json.text);
  process.exit(0);
});
