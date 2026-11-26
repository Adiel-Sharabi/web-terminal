#!/usr/bin/env node
'use strict';
// Say whether a project's usage is WORK or PRIVATE (#529), from a shell or an agent.
//
//   node scripts/usage-classify.js <project> work|private|auto   [--server <url|name>]
//
// `<project>` is the project key a report shows (the repository's name, lower-cased). The override is
// written into this machine's own ledger by POST /api/usage/classify, so it replicates to every machine,
// and the newest override per project wins everywhere. `auto` withdraws an override: the project is then
// work when the work-source machine has it in its inventory (usageLedger.workSource), else private.
// Without --server, this machine's own server is used, with a token from its api-tokens.json.

const api = require('./wt-api');

const args = process.argv.slice(2);
const i = args.indexOf('--server');
const server = i < 0 ? undefined : args[i + 1];
const [project, as] = args.filter((a, k) => !a.startsWith('--') && !(k > 0 && args[k - 1] === '--server'));

(async () => {
  if (!project || !['work', 'private', 'auto'].includes(as)) {
    process.stderr.write('usage: node scripts/usage-classify.js <project> work|private|auto [--server <url|name>]\n');
    process.exit(2);
  }
  const t = api.target(server);
  const r = await api.call(t, 'POST', '/api/usage/classify', { project, as });
  if (r.status !== 200) { process.stderr.write(`usage-classify: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}\n`); process.exit(2); }
  process.stdout.write(`${t.url}: ${r.json.record.project} is now ${r.json.record.as} (record ${r.json.record.origin}#${r.json.record.seq})\n`);
})().catch((e) => { process.stderr.write(`usage-classify: ${e.message}\n`); process.exit(2); });
