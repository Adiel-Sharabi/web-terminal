'use strict';
// Best-effort extraction of Claude's last assistant message from a Claude Code
// transcript JSONL, so a phone push can quote what Claude actually said/asked
// rather than a generic "needs approval" / "is done". Reads only the file tail
// and walks backward to the newest assistant turn that carries text content
// (tool-use-only turns are skipped — we want prose). Any failure (missing file,
// malformed lines) returns '' and the caller pushes its normal message unchanged.
const fs = require('fs');

const TAIL_BYTES = 262144; // last 256KB is plenty for the final few turns
const DEFAULT_MAX = 200;

// Pull the concatenated text blocks out of one transcript line's object, but
// only if it is an assistant turn. Handles both the array-of-blocks content
// shape and the (older) plain-string content shape.
function _assistantText(obj) {
  const m = obj && obj.message;
  const role = (m && m.role) || (obj && obj.role);
  if (!obj || (obj.type !== 'assistant' && role !== 'assistant')) return '';
  const content = m && m.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join(' ')
      .trim();
  }
  return '';
}

function lastAssistantText(transcriptPath, maxLen = DEFAULT_MAX) {
  try {
    if (!transcriptPath) return '';
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    // If we started mid-file, drop the leading partial line.
    if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const out = _assistantText(obj).replace(/\s+/g, ' ').trim();
      if (out) return out.length > maxLen ? out.slice(0, maxLen - 1).trimEnd() + '…' : out;
    }
    return '';
  } catch { return ''; }
}

module.exports = { lastAssistantText };
