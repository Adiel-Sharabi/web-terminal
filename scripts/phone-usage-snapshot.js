#!/usr/bin/env node
'use strict';
// Phone usage snapshot (#425): the companion's foreground time today, pulled over adb
// into a local jsonl. Android keeps per-day app usage only ~10 days, so a daily run on
// the machine that has adb keeps the history.
//
//   node scripts/phone-usage-snapshot.js --device <host:port> [--package <id>] [--adb <path>] [--out <file>]
//
// READ-ONLY on the device: `adb get-state`, `adb shell date`, `adb shell dumpsys usagestats`.
// It never drives the UI. One line per (device, day, package) in logs/phone-usage.jsonl
// (override: --out or WT_PHONE_USAGE_FILE); re-running the same day REPLACES that line.
//
// What `dumpsys usagestats` offers (measured on Android 17 / One UI, 2026-11-05): the
// "In-memory daily stats" block is the CURRENT day's bucket (earlier days are binary files
// the dump does not print), with per-package `totalTimeUsed` / `totalTimeVisible` and the
// screen-interactive aggregate. So a snapshot is "the day so far"; run it late in the day.
// Times print as mm:ss or h:mm:ss. The range header prints a locale date, so the day is
// read against the device's own date and the script refuses when neither M/D nor D/M agrees.
// Anything it cannot read aborts: a guessed zero would pass for a day nobody used the app.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/// "30:45" -> 1845000, "4:22:48" -> 15768000; null when the text is not a duration.
function parseDuration(text) {
  const m = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  return (((Number(m[1] || 0) * 60) + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/// The day of the daily block's `timeRange="11/5/2026, 00:13 - 14:35"`, as YYYY-MM-DD,
/// given the device's own date [deviceDay] (YYYY-MM-DD). The text is M/D/YYYY on an en-US
/// device and D/M/YYYY elsewhere; the reading that equals [deviceDay] wins, none -> null.
function dayOfRange(rangeText, deviceDay) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(rangeText || ''));
  if (!m) return null;
  const iso = (mo, d) => `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (const cand of [iso(m[1], m[2]), iso(m[2], m[1])]) if (cand === deviceDay) return cand;
  return null;
}

/// Parse the dump. Returns { day, package, usedMs, visibleMs, launches, screenOnMs }
/// or throws an Error saying what was missing. Pure.
function parseUsageStats(dump, pkg, deviceDay) {
  const text = String(dump || '');
  const start = text.indexOf('In-memory daily stats');
  if (start < 0) throw new Error('no "In-memory daily stats" block in the dumpsys output (unsupported Android version?)');
  const rest = text.slice(start + 'In-memory daily stats'.length);
  const endRel = rest.search(/\n\s*In-memory (weekly|monthly|yearly) stats/);
  const block = endRel < 0 ? rest : rest.slice(0, endRel);
  const range = /timeRange="([^"]*)"/.exec(block);
  if (!range) throw new Error('the daily stats block has no timeRange');
  const day = dayOfRange(range[1], deviceDay);
  if (!day) throw new Error(`the daily stats range "${range[1].trim()}" does not match the device date ${deviceDay}`);
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^\\s*package=${esc}\\s+totalTimeUsed="([^"]*)".*$`, 'm').exec(block);
  if (!line) throw new Error(`package ${pkg} has no usage entry in today's stats`);
  const field = (name) => { const f = new RegExp(`${name}="([^"]*)"`).exec(line[0]); return f ? parseDuration(f[1]) : null; };
  const usedMs = parseDuration(line[1]);
  const visibleMs = field('totalTimeVisible');
  if (usedMs === null || visibleMs === null) throw new Error(`cannot read the durations on the ${pkg} line`);
  const launches = /appLaunchCount=(\d+)/.exec(line[0]);
  const screen = /screen-interactive: \d+x for "([^"]*)"/.exec(block);
  return {
    day, package: pkg, usedMs, visibleMs,
    launches: launches ? Number(launches[1]) : null,
    screenOnMs: screen ? parseDuration(screen[1]) : null,
  };
}

/// Replace-or-add: [lines] are the existing jsonl lines, [rec] the new record. The key is
/// (device, day, package); other lines (and unparseable ones) are kept untouched. Pure.
function upsertLines(lines, rec) {
  const kept = lines.filter((l) => {
    if (!l.trim()) return false;
    try { const o = JSON.parse(l); return !(o.device === rec.device && o.day === rec.day && o.package === rec.package); } catch { return true; }
  });
  kept.push(JSON.stringify(rec));
  return kept;
}

/// The companion's applicationId, read from its gradle file (the one owner).
function defaultPackage(root = path.join(__dirname, '..')) {
  const dir = path.join(root, 'ai-terminal', 'android', 'app');
  for (const f of ['build.gradle.kts', 'build.gradle']) {
    try {
      const m = /applicationId\s*=?\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m) return m[1];
    } catch { /* try the next */ }
  }
  return null;
}

function adb(adbPath, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`adb ${args.join(' ')} failed: ${(stderr || err.message).toString().trim()}`));
      resolve(String(stdout));
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.device) throw new Error('usage: phone-usage-snapshot.js --device <host:port> [--package <id>] [--adb <path>] [--out <file>]');
  const pkg = a.package || defaultPackage();
  if (!pkg) throw new Error('no --package and no applicationId found under ai-terminal/android/app');
  const adbPath = a.adb || 'adb';
  const out = a.out || process.env.WT_PHONE_USAGE_FILE || path.join(__dirname, '..', 'logs', 'phone-usage.jsonl');
  const state = (await adb(adbPath, ['-s', a.device, 'get-state'], 15000)).trim();
  if (state !== 'device') throw new Error(`device ${a.device} is not reachable (adb state: ${state || 'none'})`);
  const deviceDay = (await adb(adbPath, ['-s', a.device, 'shell', 'date', '+%Y-%m-%d'], 15000)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deviceDay)) throw new Error(`cannot read the device date (got "${deviceDay}")`);
  const dump = await adb(adbPath, ['-s', a.device, 'shell', 'dumpsys', 'usagestats']);
  const s = parseUsageStats(dump, pkg, deviceDay);
  const rec = { device: a.device, day: s.day, package: s.package, usedMs: s.usedMs, visibleMs: s.visibleMs,
    launches: s.launches, screenOnMs: s.screenOnMs, capturedAt: new Date().toISOString() };
  let existing = [];
  try { existing = fs.readFileSync(out, 'utf8').split('\n'); } catch { /* first run */ }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, `${upsertLines(existing, rec).join('\n')}\n`);
  fs.renameSync(`${out}.tmp`, out);
  console.log(`${rec.device} ${rec.day} ${rec.package}: used ${Math.round(rec.usedMs / 60000)} min, visible ${Math.round(rec.visibleMs / 60000)} min -> ${out}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`phone-usage-snapshot: ${e.message}`); process.exit(1); });
}

module.exports = { parseDuration, dayOfRange, parseUsageStats, upsertLines, defaultPackage };
