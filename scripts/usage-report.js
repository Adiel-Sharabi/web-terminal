#!/usr/bin/env node
'use strict';
// The fleet usage report (#529), from this machine's copy of the ledger.
//
//   node scripts/usage-report.js [--days 7] [--work | --private] [--machine <name>] [--json]
//                                [--server <url|name>] [--dir <ledger dir>] [--work-source <machine>]
//
// Every machine holds every machine's ledger (lib/usage-sync.js), so any of them answers; the files are read
// directly (read-only: a running server may be appending to them), so this works with the server stopped too.
// `--server` asks that cluster peer's GET /api/usage/report instead (a peer's own copy, its own work-source
// setting). The same pure function (lib/usage-report.js) builds both. `--json` prints the report object,
// otherwise a terminal summary that says how each figure was measured.
//
// `--work` / `--private`: only projects classed as work / private (lib/usage-classify.js); change a class
// with scripts/usage-classify.js.

const path = require('path');
const api = require('./wt-api');
const { createUsageStore } = require('../lib/usage-store');
const { buildReport, renderText } = require('../lib/usage-report');
const { configFrom } = require('../lib/usage-service');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };

async function main() {
  const days = flag('--days') === undefined ? 7 : Number(flag('--days'));
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new Error('--days must be a whole number from 1 to 400');
  const scope = args.includes('--work') ? 'work' : args.includes('--private') ? 'private' : 'all';
  const machine = typeof flag('--machine') === 'string' ? flag('--machine') : null;
  let report;
  if (flag('--server')) {
    const t = api.target(flag('--server'));
    const q = `days=${days}&scope=${scope}${machine ? `&machine=${encodeURIComponent(machine)}` : ''}`;
    const r = await api.call(t, 'GET', `/api/usage/report?${q}`);
    if (r.status !== 200) throw new Error(`${t.url}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    report = r.json;
  } else {
    const dir = typeof flag('--dir') === 'string' ? flag('--dir') : (process.env.WT_FLEET_USAGE_DIR || path.join(api.ROOT, 'logs', 'usage'));
    const cfg = configFrom((api.readJson(process.env.WT_CONFIG_FILE || path.join(api.ROOT, 'config.json')) || {}).usageLedger);
    const workSource = typeof flag('--work-source') === 'string' ? flag('--work-source') : cfg.workSource;
    const store = createUsageStore({ dir, origin: 'reader', readOnly: true });
    report = buildReport(store.records(), { now: Date.now(), days, scope, machine, workSource });
    if (!Object.keys(store.heads()).length) process.stderr.write(`note: no ledger files in ${dir}\n`);
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
}

main().catch((e) => { process.stderr.write(`usage-report: ${e.message}\n`); process.exit(2); });
