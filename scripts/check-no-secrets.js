#!/usr/bin/env node
'use strict';
// Gate a change on "no credentials and no machine-identifying data".
//
//   node scripts/check-no-secrets.js            # scan tracked + staged files
//   node scripts/check-no-secrets.js --diff BASE # scan only what a PR adds
//
// WHY THIS IS A GATE AND NOT A CHECKLIST ITEM. This repo shipped a working
// bearer token in a committed dev script once, and it survived until a full
// history rewrite. A reviewer eyeballing a diff will not reliably catch a
// 64-char hex string in a file they were not reading closely. A regex will.
//
// It scans ADDED lines only when given --diff, because history that has already
// been published cannot be fixed by failing today's PR.

const { execSync } = require('child_process');

const RULES = [
  // --- credentials: always fatal -------------------------------------------
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/,            'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/,          'GitHub fine-grained PAT'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/,          'Slack token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/,             'Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/,                    'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/,               'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/,      'private key'],
  [/"private_key"\s*:\s*"-----BEGIN/,         'service-account JSON'],
  [/\b(bearer|token|secret|passwd|password)\b\s*[:=]\s*['"][A-Fa-f0-9]{32,}['"]/i,
                                              'hardcoded long hex credential'],
  // --- machine-identifying data --------------------------------------------
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, 'Tailscale/CGNAT IP'],
  [/\b[a-z0-9-]+\.ts\.net\b/i,                'MagicDNS hostname'],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/,          'private LAN IP'],
  // A *real* Windows user path. Single-letter and obviously-fake names are how
  // the test suite writes examples, so they are not flagged — the rule targets a
  // plausible human account name, which is what actually identifies a machine.
  [/C:\\+Users\\+(?!yourname\b|user\b|<|%|\$)[A-Za-z][A-Za-z0-9._-]{2,}/i, 'real Windows user path'],
];

// Placeholders and documentation examples that must NOT trip the scan.
// Keep this list SHORT and specific: every entry is a hole, and a pattern broad
// enough to cover a real leak defeats the gate it is exempting.
const ALLOW = [
  /100\.x\.x\.x/, /192\.168\.x/, /100\.\d+\.x/,
  // Generic hostnames used as form placeholders / docs examples.
  /server-name\.tailnet\.ts\.net/, /my-server\.tailnet\.ts\.net/, /\bserver\.ts\.net\b/,
  /host\.tailnet\.ts\.net/, /\byour-server\./,
  // Example user paths.
  /Users\\+yourname/i, /Users\\+user\b/i,
  // GitHub-hosted runner accounts. These identify no human and appear in docs and
  // comments explaining CI behaviour — including the comment on the very test that
  // diverged because of this path's `~`.
  /Users\\+RUNNER~1/i, /Users\\+runneradmin\b/i,
  // Single-token stand-ins in transcript/path unit tests: C:\Users\x, \u, \a b
  /C:\\+Users\\+([a-z]|[a-z] [a-z])\\+/i,
];

const arg = process.argv.indexOf('--diff');
let payload;
if (arg !== -1 && process.argv[arg + 1]) {
  const base = process.argv[arg + 1];
  // Added lines only — '+' but not the '+++' file header.
  payload = execSync(`git diff ${base}...HEAD --unified=0`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
} else {
  const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('ai-terminal/third_party/'));
  const fs = require('fs');
  payload = [];
  for (const f of files) {
    let t;
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.includes('\u0000')) continue; // binary
    t.split('\n').forEach((line, i) => payload.push(`${f}:${i + 1}: ${line}`));
  }
}

const hits = [];
for (const line of payload) {
  if (ALLOW.some((a) => a.test(line))) continue;
  for (const [re, what] of RULES) {
    if (re.test(line)) { hits.push(`${what}: ${line.trim().slice(0, 160)}`); break; }
  }
}

if (hits.length) {
  console.error(`\nPotential secrets or machine-identifying data (${hits.length}):\n`);
  for (const h of hits.slice(0, 40)) console.error('  ' + h);
  if (hits.length > 40) console.error(`  … and ${hits.length - 40} more`);
  console.error('\nIf a hit is a placeholder, add it to ALLOW in scripts/check-no-secrets.js.');
  console.error('If it is real: rotate the credential first — removing the line is not enough once pushed.\n');
  process.exit(1);
}
console.log(`OK — scanned ${payload.length} lines, no secrets or machine-identifying data.`);
