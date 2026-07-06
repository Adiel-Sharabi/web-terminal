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

// --- M1: transcript_path validation ------------------------------------------
// A hook can hand us an arbitrary `transcript_path`; /attention + the ntfy detail
// then read and expose its content. Before trusting one, server.js realpath's the
// candidate + the Claude projects root and asks this pure predicate whether the
// (already resolved) path is a legitimate transcript to read: it must end in
// `.jsonl` AND sit strictly under the projects root. Kept pure (no fs) so the
// containment/extension decision is exhaustively unit-testable — traversal
// attempts, wrong extension, the exact-root edge, and win32 case-insensitivity.
// `platform` is injectable so both OS rules can be tested on any host.
function isAllowedTranscriptPath(resolvedPath, resolvedRoot, platform = process.platform) {
  if (typeof resolvedPath !== 'string' || typeof resolvedRoot !== 'string') return false;
  if (!resolvedPath || !resolvedRoot) return false;
  const isWin = platform === 'win32';
  const casefold = (s) => (isWin ? s.toLowerCase() : s);
  // Extension gate first — only Claude transcript JSONL files.
  if (!casefold(resolvedPath).endsWith('.jsonl')) return false;
  // Normalize separators (win32 accepts both '/' and '\') + case, then strip any
  // trailing separator from the root so the containment compare is unambiguous.
  const sep = isWin ? '\\' : '/';
  const norm = (p) => casefold(isWin ? p.replace(/\//g, '\\') : p);
  const root = norm(resolvedRoot).replace(/[\\/]+$/, '');
  const target = norm(resolvedPath);
  // Strictly inside: the char right after the root must be a separator. This also
  // blocks the "…/projects-evil/x.jsonl" prefix-collision (root itself, with no
  // trailing file, is not a transcript, so equality is intentionally rejected).
  return target.startsWith(root + sep);
}

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

// --- G5: structured transcript pagination ------------------------------------
// The companion app's chat view needs the whole conversation as typed turns, not
// just the last message. These helpers are PURE (no fs) so the parsing, tool-use
// extraction, cursor codec, and backward paginator are all exhaustively unit-
// testable; server.js supplies the file I/O (a chunk reader) at call time.

const TURN_TEXT_CAP = 65536;        // 64KB per turn (truncate + '…')
const TOOL_PREVIEW_CAP = 80;        // first ~80 chars of the stringified tool input
const DEFAULT_PAGE = 50;            // turns per page when the client omits `limit`
const MAX_PAGE = 200;               // hard cap so one request can't pull the world
const SCAN_CHUNK = 262144;          // 256KB backward-read chunk

// Defensive ANSI/escape-sequence strip. Transcript prose is normally clean, but a
// tool result or pasted blob can carry terminal control bytes; the chat view must
// render plain text, never move the cursor or set colors. Covers CSI (ESC[…final),
// OSC (ESC]…BEL/ST), and lone two-char escapes. Not a full terminal parser — just
// enough to neutralise anything that slipped into stored prose.
const _ESC = String.fromCharCode(0x1b); // ESC (not stored as a raw byte in source)
const _BEL = String.fromCharCode(0x07); // BEL — one OSC terminator
const _BS = String.fromCharCode(0x5c);  // backslash — regex needs it literally
const ANSI_RE = new RegExp(
  _ESC + _BS + '[[0-?]*[ -/]*[@-~]'                         // CSI: ESC [ ... final(@-~)
  + '|' + _ESC + _BS + '][^' + _BEL + _ESC + ']*(?:' + _BEL + '|' + _ESC + _BS + _BS + ')' // OSC: ESC ] ... (BEL|ST)
  + '|' + _ESC + '[@-_]',                                   // Fe: ESC + 0x40-0x5F
  'g'
);
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : '';
}

// Cap one turn's text: strip control sequences, then bound the length so a single
// runaway turn can't bloat a page. Mirrors lastAssistantText's ellipsis contract
// (result length === cap when truncated).
function _capTurnText(s) {
  const clean = stripAnsi(s);
  return clean.length > TURN_TEXT_CAP ? clean.slice(0, TURN_TEXT_CAP - 1) + '…' : clean;
}

// Pull user-turn text out of one line object: string content, or the text blocks
// of an array content. tool_result blocks are plumbing (not conversation) and are
// ignored here — a user line carrying ONLY tool_result(s) yields '' and is skipped
// by the caller. Never returns assistant text (role-gated by parseTranscriptTurn).
function _userText(obj) {
  const m = obj && obj.message;
  const content = m && m.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// Collect the tool_use blocks of an assistant line as compact chips for the chat
// view: {name, inputPreview}. inputPreview is the first ~80 chars of the input
// JSON, ANSI-stripped, so the app can show "Bash: {"command":"npm test"…}" without
// shipping (or trusting) the full input. Non-assistant lines have no tool_use.
function _toolUses(obj) {
  const m = obj && obj.message;
  const content = m && m.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    let preview = '';
    try { preview = JSON.stringify(b.input == null ? {} : b.input); } catch { preview = ''; }
    preview = stripAnsi(preview);
    if (preview.length > TOOL_PREVIEW_CAP) preview = preview.slice(0, TOOL_PREVIEW_CAP - 1) + '…';
    out.push({ name: (b && typeof b.name === 'string') ? b.name : '', inputPreview: preview });
  }
  return out;
}

// Total context tokens carried into this assistant turn's request: the fresh
// input plus both cache tiers. This is what fills the context window, so the app
// can derive an approximate ctx% for sessions whose live status line isn't
// posting (idle). Returns null when the line has no usage block.
function _ctxTokens(obj) {
  const u = (obj && obj.message && obj.message.usage) || (obj && obj.usage);
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (typeof v === 'number' && v > 0 ? v : 0);
  const total =
    n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

// Parse ONE transcript JSONL line into a typed chat turn, or null if the line is
// not conversational and should be skipped. Skips: JSON.parse failures; assistant
// lines with neither text nor tool_use; user lines with no text (e.g. tool_result-
// only plumbing). ts comes from the line's `timestamp` when present, else null.
// PURE — safe to unit-test with hand-written line strings.
function parseTranscriptTurn(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const m = obj.message;
  const role = (m && m.role) || obj.role;
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;

  if (obj.type === 'assistant' || role === 'assistant') {
    const text = _capTurnText(_assistantText(obj));
    const toolUses = _toolUses(obj);
    if (!text && toolUses.length === 0) return null; // nothing to show
    return { role: 'assistant', text, toolUses, ts, ctxTokens: _ctxTokens(obj) };
  }
  if (obj.type === 'user' || role === 'user') {
    const text = _capTurnText(_userText(obj));
    if (!text) return null; // tool_result-only / empty → plumbing, skip
    return { role: 'user', text, toolUses: [], ts };
  }
  return null; // system / summary / other line types are not conversation
}

// Opaque cursor codec. A cursor is just a byte offset of a line START in the
// transcript file, base64'd so the client treats it as opaque. Decoding rejects
// anything that isn't a clean non-negative integer (caller then 400s).
function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  let s;
  try { s = Buffer.from(cursor, 'base64').toString('utf8'); } catch { return null; }
  if (!/^\d+$/.test(s)) return null;          // must be pure digits
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  // Round-trip guard: reject padding/whitespace tricks that decode to the same
  // digits but weren't produced by encodeCursor.
  if (encodeCursor(n) !== cursor) return null;
  return n;
}

// Backward paginator (PURE — I/O is injected). Walks the transcript from `before`
// (exclusive byte offset; file end when null) toward the file start, reading fixed
// chunks via readChunk(offset, length) -> Buffer, reconstructing complete lines
// across chunk boundaries, and collecting up to `limit` parseable turns. Because it
// reads only what a page needs, a tens-of-MB transcript costs a few chunks, not a
// full-file read.
//
// Returns { turns, cursor, hasMore }:
//   - turns : newest-LAST array of typed turns (collected newest-first, reversed).
//   - hasMore: true if we stopped on `limit` before reaching the file start (older
//     turns remain). false once byte 0 is consumed. NOTE: hasMore can be true while
//     the next page turns out empty — when only non-conversational lines (tool_result
//     plumbing, malformed) precede the cursor. The client simply gets a final empty
//     page with hasMore=false; no turns are ever lost.
//   - cursor : opaque token = the line-start offset of the OLDEST turn on this page,
//     to be passed back as `before` for the previous page. null when hasMore=false
//     or the page is empty.
function scanTurnsBackward(readChunk, fileSize, opts = {}) {
  const limit = Math.max(1, Math.min(MAX_PAGE, opts.limit || DEFAULT_PAGE));
  const chunkSize = opts.chunkSize || SCAN_CHUNK;
  const end = (opts.before == null) ? fileSize : opts.before; // exclusive upper bound
  let bufStart = end;                 // buf holds bytes [bufStart, hi)
  let hi = end;
  let buf = Buffer.alloc(0);
  const turns = [];                   // newest-first
  let oldestStart = end;              // line-start offset of the oldest kept turn
  let reachedStart = false;

  const take = (lineStart, lineBuf) => {
    const turn = parseTranscriptTurn(lineBuf.toString('utf8'));
    if (turn) { turns.push(turn); oldestStart = lineStart; }
  };

  while (turns.length < limit) {
    const nl = buf.lastIndexOf(0x0a); // last '\n' in the loaded window
    if (nl === -1) {
      if (bufStart === 0) {
        // No newline before us and we're at the file head → buf is the first line.
        reachedStart = true;
        take(0, buf);
        break;
      }
      // Need more bytes to the left to find this line's start.
      const readLen = Math.min(chunkSize, bufStart);
      const chunk = readChunk(bufStart - readLen, readLen);
      buf = Buffer.concat([chunk, buf]);
      bufStart -= readLen;
      continue;
    }
    // The line to the RIGHT of this newline is complete: [bufStart+nl+1, hi).
    const lineStart = bufStart + nl + 1;
    take(lineStart, buf.slice(nl + 1));
    // Drop the processed line and its terminating newline; keep scanning left.
    buf = buf.slice(0, nl);
    hi = bufStart + nl;
  }

  turns.reverse(); // newest-last for the chat view
  const hasMore = !reachedStart;
  const cursor = (hasMore && turns.length > 0) ? encodeCursor(oldestStart) : null;
  return { turns, cursor, hasMore };
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

module.exports = {
  lastAssistantText,
  isAllowedTranscriptPath,
  // G5 structured transcript
  parseTranscriptTurn,
  scanTurnsBackward,
  encodeCursor,
  decodeCursor,
  stripAnsi,
  DEFAULT_PAGE,
  MAX_PAGE,
};
