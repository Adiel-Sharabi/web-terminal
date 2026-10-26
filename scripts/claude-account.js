#!/usr/bin/env node
'use strict';
// Switch this machine's Claude Code login between saved accounts (#389).
//
//   node scripts/claude-account.js status            # who is logged in, what is saved
//   node scripts/claude-account.js save [label]      # keep the current login (label: its email)
//   node scripts/claude-account.js switch <label>    # save the current login, then load <label>
//
// The rule lives in lib/claude-account.js (also behind /api/claude-account, the
// companion's per-machine "Switch account"); this file only formats it for a terminal.
// To add an account on a machine: /login to it in any Claude session there, then `save`.
// Never copy a saved login to another machine.
const account = require('../lib/claude-account');

function when(ms) {
  if (typeof ms !== 'number') return 'unknown';
  const days = (ms - Date.now()) / (24 * 60 * 60 * 1000);
  const rel = days < 0 ? 'EXPIRED' : days < 1 ? `in ${Math.round(days * 24)} h` : `in ${Math.round(days)} d`;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z (${rel})`;
}

function details(a) {
  const lines = [`    plan: ${a.plan || '?'}  org: ${a.organization || '?'}`];
  lines.push(`    refresh token expires ${when(a.refreshExpiresAt)}`);
  if (a.refreshExpiringSoon) {
    lines.push(`    WARNING: refresh token expires within ${account.REFRESH_WARN_DAYS} days - /login to this account again, then save`);
  }
  return lines.join('\n');
}

function cmdStatus() {
  const { active, saved } = account.status();
  console.log(active
    ? `active: ${active.email}${active.label ? ` (saved as "${active.label}")` : ' (NOT saved - run save)'}\n${details(active)}`
    : 'active: none (not logged in)');
  console.log(saved.length ? '\nsaved:' : '\nsaved: none');
  for (const s of saved) {
    if (s.broken) { console.log(`  ${s.label}: UNREADABLE`); continue; }
    console.log(`  ${s.label}: ${s.email}, saved ${s.savedAt}${s.active ? ' (active: the live copy above is newer)' : ''}`);
    if (!s.active) console.log(details(s));
  }
}

function main([verb, arg]) {
  if (verb === 'status') return cmdStatus();
  if (verb === 'save') {
    const r = account.save(arg);
    return console.log(`saved ${r.email} as "${r.label}"`);
  }
  if (verb === 'switch') {
    const r = account.switchTo(arg);
    if (r.alreadyActive) return console.log(`already on ${r.to}; refreshed its saved copy "${r.label}"`);
    if (r.from) console.log(`saved ${r.from} first`);
    if (r.warning) console.error(`WARNING: ${r.warning}`);
    return console.log(`switched to ${r.to}. Check /status in a running session.`);
  }
  throw new account.Refusal('usage: claude-account.js status | save [label] | switch <label|email>');
}

try {
  main(process.argv.slice(2));
} catch (e) {
  const refused = e instanceof account.Refusal;
  console.error(`claude-account: ${refused ? e.message : e.stack || e.message}`);
  process.exit(refused ? 2 : 1);
}
