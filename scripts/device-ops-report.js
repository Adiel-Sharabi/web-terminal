#!/usr/bin/env node
'use strict';
// #311 - which device sent each prompt, per device: operations, active hours, and how
// many fell in office hours (Sunday-Thursday 09:00-18:00, this machine's local time).
//
//   node scripts/device-ops-report.js [file ...] [--since YYYY-MM-DD] [--json]
//
// Files default to this checkout's logs/device-ops.jsonl. Pass several (one per
// server, e.g. copied from each peer) to report the whole cluster at once.
//
// Sources are tailnet IPs; they are named here, from `tailscale status --json`, so the
// log itself carries nothing machine-specific. A device's class follows from its OS
// (Android/iOS -> mobile, else desktop); name a tablet in config.json:
//   "deviceClasses": { "<tailnet host name>": "tablet" }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { summarize } = require('../lib/device-ops');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? Date.parse(args[sinceIdx + 1]) : null;
if (sinceIdx >= 0 && Number.isNaN(since)) { console.error('--since needs a date, e.g. 2026-10-07'); process.exit(2); }
const files = args.filter((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1));
if (!files.length) files.push(path.join(ROOT, 'logs', 'device-ops.jsonl'));

function readRecords(file) {
  const out = [];
  if (!fs.existsSync(file)) { console.error(`(no log at ${file})`); return out; }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function tailnetDevices() {
  const exe = process.env.TAILSCALE_EXE
    || (process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale');
  const map = new Map();
  try {
    const st = JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8', windowsHide: true }));
    for (const node of [st.Self, ...Object.values(st.Peer || {})]) {
      if (!node) continue;
      const host = String(node.DNSName || '').split('.')[0] || node.HostName;
      for (const ip of node.TailscaleIPs || []) map.set(ip, { host, os: node.OS || '' });
    }
  } catch (e) {
    console.error(`(tailscale status unavailable: ${e.message.split('\n')[0]}; devices are shown by address)`);
  }
  return map;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(process.env.WT_CONFIG_FILE || path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
}

/// Server name -> tailnet host, from this server's own `serverName`/`publicUrl` and the
/// `cluster` list, so a client on a server's own machine shares that machine's row.
function serverHosts(cfg) {
  const map = new Map();
  const add = (name, url) => {
    try { if (name && url) map.set(name, new URL(url).hostname.split('.')[0]); } catch {}
  };
  add(cfg.serverName, cfg.publicUrl);
  for (const s of cfg.cluster || []) add(s.name, s.url);
  return map;
}

let records = files.flatMap(readRecords);
if (since !== null) records = records.filter((r) => Date.parse(r.t) >= since);
const cfg = readConfig();
const devices = tailnetDevices();
const hosts = serverHosts(cfg);
const rows = summarize(records, {
  resolve: (src) => devices.get(src),
  serverHost: (name) => hosts.get(name),
  classes: cfg.deviceClasses || {},
});

if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
if (!rows.length) { console.log('No operations recorded yet.'); process.exit(0); }

const times = records.map((r) => Date.parse(r.t)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
const day = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`${records.length} operations, ${day(times[0])} to ${day(times[times.length - 1])}\n`);
const head = ['device', 'class', 'ops', 'share', 'office hrs', 'outside', 'active h'];
const total = rows.reduce((s, r) => s + r.ops, 0);
const table = rows.map((r) => [r.device, r.cls, r.ops, `${Math.round((r.ops / total) * 100)}%`, r.office, r.outside, r.hours.toFixed(1)]);
const byClass = {};
for (const r of rows) {
  const c = (byClass[r.cls] ||= { ops: 0, office: 0, outside: 0, hours: 0 });
  c.ops += r.ops; c.office += r.office; c.outside += r.outside; c.hours += r.hours;
}
table.push(['', '', '', '', '', '', '']);
for (const [cls, c] of Object.entries(byClass).sort((a, b) => b[1].ops - a[1].ops)) {
  table.push([`all ${cls}`, '', c.ops, `${Math.round((c.ops / total) * 100)}%`, c.office, c.outside, c.hours.toFixed(1)]);
}
const width = head.map((h, i) => Math.max(h.length, ...table.map((r) => String(r[i]).length)));
const fmt = (r) => r.map((v, i) => (i < 2 ? String(v).padEnd(width[i]) : String(v).padStart(width[i]))).join('  ');
console.log(fmt(head));
for (const r of table) console.log(fmt(r));
