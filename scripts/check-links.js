#!/usr/bin/env node
'use strict';
// Verify every relative link and every #anchor across the repo's markdown.
// Exits non-zero on the first broken set, so CI can gate a PR on it.
//
//   node scripts/check-links.js
//
// TRAP THIS EXISTS TO AVOID: an earlier ad-hoc version listed files with
// `git ls-files`, so it was blind to files a PR had ADDED but not yet committed
// — it reported "0 broken" over a set that excluded the very docs under review.
// It now includes untracked-but-not-ignored files, which is what a PR author has
// on disk. Verified by deliberately adding a doc with a bad link and watching
// this go red.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const files = execSync('git ls-files --cached --others --exclude-standard "*.md"',
  { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('ai-terminal/third_party/')); // vendored upstream docs

// GitHub's heading->anchor rule: lowercase, strip punctuation, spaces to dashes.
const slug = (h) => h.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');

const anchors = {};
for (const f of files) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  anchors[f] = new Set((text.match(/^#{1,6} .+$/gm) || []).map((h) => slug(h.replace(/^#+ /, ''))));
}

const broken = [];
let checked = 0;
for (const f of files) {
  const dir = path.dirname(f);
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = m[2];
    if (/^(https?:|mailto:)/.test(target)) continue; // external: not our job
    checked++;
    if (target.startsWith('#')) {
      if (!anchors[f].has(target.slice(1))) broken.push(`${f} -> ${target}  (no such heading in this file)`);
      continue;
    }
    const [rel, frag] = target.split('#');
    const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, rel));
    if (!fs.existsSync(path.join(ROOT, resolved))) { broken.push(`${f} -> ${target}  (file not found)`); continue; }
    if (frag && anchors[resolved] && !anchors[resolved].has(frag)) {
      broken.push(`${f} -> ${target}  (no such heading in ${resolved})`);
    }
  }
}

if (broken.length) {
  console.error(`\nBroken links (${broken.length}):\n`);
  for (const b of broken) console.error('  ' + b);
  console.error(`\n${files.length} docs, ${checked} internal links checked.\n`);
  process.exit(1);
}
console.log(`OK — ${files.length} docs, ${checked} internal links, 0 broken.`);
