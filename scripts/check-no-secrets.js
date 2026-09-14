#!/usr/bin/env node
'use strict';
// Gate a change on "no credentials and no machine-identifying data".
//
//   node scripts/check-no-secrets.js            # scan the whole working tree (#260)
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
// What the summary line claims coverage of. It is built where the scan is built, so it
// can never describe a scope the scan did not have — see #260 below.
let scope;
if (arg !== -1 && process.argv[arg + 1]) {
  const base = process.argv[arg + 1];
  // Added lines only — '+' but not the '+++' file header.
  payload = execSync(`git diff ${base}...HEAD --unified=0`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  scope = `${payload.length} added lines vs ${base}`;
} else {
  // TRACKED **AND** UNTRACKED-BUT-NOT-IGNORED (#260).
  //
  // `git ls-files` on its own lists only TRACKED files, so a brand-new file was invisible
  // to this gate — and a brand-new file is exactly the one most likely to carry a token
  // somebody pasted in to see something work. It failed OPEN, silently, and printed a
  // reassuring `OK` with a six-figure line count that made it look thorough. PR #256
  // reproduced it exactly: green locally (`OK — scanned 132759 lines`) and red in CI on
  // two hits in a file the local run never opened, because on the branch everything was
  // tracked. It also left any commit made without `git add` — plumbing against a
  // throwaway index, the documented way to commit while another agent owns the working
  // tree — with no local coverage at all.
  //
  // `--exclude-standard` IS THE LOAD-BEARING FLAG, not tidiness. `config.json`,
  // `cluster-tokens.json` and `api-tokens.json` are gitignored and hold REAL credentials
  // on every box in this fleet; all three sit in the root of a normal checkout. A
  // widening that scanned them would print their contents into a public CI log — this
  // gate causing the leak it exists to prevent. Verified on this checkout (present on
  // disk, listed by neither invocation) and pinned by `tests/check-no-secrets.spec.js`,
  // which asserts a gitignored file carrying a placeholder secret is NOT reported.
  //
  // `-z` IS THE SECOND LOAD-BEARING FLAG, for the same reason `--exclude-standard` is the
  // first. Without it `git ls-files` C-QUOTES any path with a non-ASCII byte - a Hebrew
  // filename comes back as the 39-character string
  // `"wt261-\327\251\327\234\327\225\327\235-probe.txt"`, quotes included - and
  // `readFileSync` on that string throws ENOENT, so the file is skipped while STILL BEING
  // COUNTED as scanned. That is #260's own defect reproduced inside #260's fix, on a fleet
  // that works in Hebrew every day: a pasted token in such a file passed the gate under
  // `OK - scanned ... + 1 untracked files`. `-z` emits raw bytes NUL-separated, so no
  // quoting happens and no decoding is needed.
  const list = (args) => execSync(`git ls-files -z ${args}`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)
    .filter((f) => !f.startsWith('ai-terminal/third_party/'));
  // `--cached` can list one path several times (one row per stage during a merge
  // conflict), so tracked is de-duplicated and untracked is filtered against it: reading
  // a file twice would double its lines inside the very count the summary prints.
  const tracked = [...new Set(list('--cached'))];
  const trackedSet = new Set(tracked);
  const untracked = list('--others --exclude-standard').filter((f) => !trackedSet.has(f));
  const fs = require('fs');
  payload = [];
  // COUNT WHAT WAS READ, NEVER WHAT WAS LISTED. The listed total is what made the
  // quoting bug above invisible, and the same arithmetic hides a binary skip: the
  // tracked PNGs were reported as "scanned" while never being examined. Four outcomes,
  // counted separately, so no number can imply coverage that another one lacks.
  let read = 0;
  let binary = 0;
  let vanished = 0;
  let notAFile = 0; // gitlinks/submodules: listed by git, not a file to read
  const unreadable = [];
  for (const f of tracked.concat(untracked)) {
    let t;
    try {
      t = fs.readFileSync(f, 'utf8');
    } catch (e) {
      // A path listed a moment ago and gone now is benign - a concurrent checkout, a
      // build cleaning up after itself. ANY OTHER failure is a file this gate could not
      // examine, and "I could not open it" is not "it is clean", so it is fatal rather
      // than skipped. That is the whole lesson of #260 applied to the read as well as
      // to the listing.
      if (e.code === 'ENOENT') { vanished++; continue; }
      // EISDIR IS NOT A FAILURE EITHER, and this one is a landmine rather than a
      // nicety. A SUBMODULE is listed by `git ls-files` as a gitlink - the DIRECTORY
      // path, mode 160000 - and `readFileSync` on a directory throws EISDIR. Treating
      // that as fatal would redden this gate on every single run the moment anyone adds
      // a submodule, for a reason that has nothing to do with secrets. A gate that
      // reddens for non-security reasons is one people learn to bypass, which is worse
      // than the hole it was guarding. There is nothing to scan in either case: a
      // gitlink's contents live in another repository.
      //
      // MEASURED, not assumed: this checkout has no .gitmodules and no mode-160000
      // entry today, and `readFileSync` on a directory was confirmed to give EISDIR
      // while a missing path gives ENOENT. So this is a latent case, named before it
      // bites rather than after.
      if (e.code === 'EISDIR') { notAFile++; continue; }
      unreadable.push(`${f} (${e.code || e.message})`);
      continue;
    }
    if (t.includes('\u0000')) { binary++; continue; } // binary
    read++;
    t.split('\n').forEach((line, i) => payload.push(`${f}:${i + 1}: ${line}`));
  }
  // A GATE THAT SCANNED NOTHING PASSES EVERYTHING, and this is not hypothetical: while
  // fixing the quoting bug above, a half-applied edit left `-z` off while the split still
  // used NUL. The whole listing became ONE impossible filename, every read failed, and the
  // gate exited 0 over a tree it had not opened - the #260 failure in its purest form,
  // introduced by #260's own fix. A repo always has tracked files, so reading none of them
  // is a broken gate rather than a clean tree. No threshold, no tuning: only zero is
  // impossible, and any number picked above it would be the fixed bet this repo keeps
  // paying for.
  if (tracked.length && !read) {
    console.error(`\n${tracked.length} tracked file(s) were listed and NONE could be read as text.`);
    console.error('That is a broken scan, not a clean tree - the gate refuses rather than pass.\n');
    process.exit(1);
  }
  if (unreadable.length) {
    console.error(`\n${unreadable.length} file(s) could not be read, so they were NOT scanned:\n`);
    for (const u of unreadable.slice(0, 20)) console.error('  ' + u);
    console.error('\nAn unexamined file is not a clean file. Fix the access error and re-run.\n');
    process.exit(1);
  }
  // SAY WHAT WAS COVERED, not merely how much was read. "scanned N lines" is what kept
  // the blind spot invisible: a large number implies thoroughness and names no scope, so
  // nobody thought to ask which files it meant.
  scope = `${payload.length} lines READ from ${read} of ${tracked.length} tracked `
    + `+ ${untracked.length} untracked files`
    + (binary ? `, ${binary} binary skipped` : '')
    + (vanished ? `, ${vanished} vanished mid-scan` : '')
    + (notAFile ? `, ${notAFile} gitlink(s) skipped` : '');
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
console.log(`OK — scanned ${scope}, no secrets or machine-identifying data.`);
