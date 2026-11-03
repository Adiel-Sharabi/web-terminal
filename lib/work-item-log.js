'use strict';
// #413 - the work-item event log: append-only JSONL, one line per event (lib/work-items.js
// eventRecord), rotated to ONE older generation (`<file>.1`) when it would pass maxBytes.
// Reads take both generations, oldest first. Synchronous on purpose, like the #345
// hand-off log: a line is written when an item enters a report, changes state, or a
// session ends - a handful an hour - and a read happens only when someone asks about an item.

const fs = require('fs');
const path = require('path');

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;

/// Append [lines] (objects). Rotates first when the file plus these lines would pass
/// [maxBytes]. Throws on a write failure: the caller logs it and carries on.
function appendLines(file, lines, { maxBytes = MAX_BYTES_DEFAULT } = {}) {
  if (!Array.isArray(lines) || !lines.length) return;
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* absent: a first write */ }
  if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxBytes) {
    try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* the rename below reports it */ }
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, text, 'utf8');
}

function _parse(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    // A torn last line (a write cut short) is skipped, never a reason to lose the rest.
    try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j); } catch { /* skip */ }
  }
  return out;
}

/// Every line of both generations, oldest first. An absent file is no lines.
function readLines(file) {
  return [..._parse(`${file}.1`), ..._parse(file)];
}

module.exports = { MAX_BYTES_DEFAULT, appendLines, readLines };
