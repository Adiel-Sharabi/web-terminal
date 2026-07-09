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
const TOOL_INPUT_CAP = 2000;        // per-field cap of a tool_use input (rich cards)
const TOOL_RESULT_CAP = 4000;       // cap of a tool_result's text (rich cards)
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

// --- #42: cwd -> Claude project-dir encoding (SINGLE source of truth) ---------
// Claude Code stores a project's transcripts under
// <claudeHome>/.claude/projects/<dir>, where <dir> is the working directory with
// EVERY non-alphanumeric character replaced by '-' — drive colon, path separators,
// underscores, dots, spaces, unicode all become '-'; case is preserved; runs are
// NOT collapsed (each char -> one dash). Verified empirically against
// ~/.claude/projects, e.g. C:\dev\Acme_Core -> C--dev-Acme-Core and
// C:\dev\am8\.claude-tmp -> C--dev-am8--claude-tmp.
// This is the ONE encoder: server.js (deriveTranscriptPath) and pty-worker.js
// (Claude-session-from-dir detection) both call it. The old inline copies only
// replaced '\'/'/', leaving '_'/'.'/space intact, so any such cwd resolved to a
// non-existent dir and the Chat lens vanished for that session (#42).
function claudeProjectDirName(cwd) {
  return typeof cwd === 'string' ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : '';
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
    // `id` pairs the tool_use with its later tool_result (see extractToolResults +
    // scanTurnsBackward); `input` is the ANSI-stripped, per-field-capped input so
    // the app can render rich cards (Bash command, Task description, file path…).
    out.push({
      name: (b && typeof b.name === 'string') ? b.name : '',
      inputPreview: preview,
      id: (b && typeof b.id === 'string') ? b.id : '',
      input: _capInput(b.input),
    });
  }
  return out;
}

// A tool_use `input` reduced for shipping to the chat: ANSI-stripped, with every
// string value (and any nested array/object, compact-stringified) capped so a
// giant command/patch can't bloat a turn. Non-objects → {}.
function _capInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const cap = (s) => {
    s = stripAnsi(String(s));
    return s.length > TOOL_INPUT_CAP ? s.slice(0, TOOL_INPUT_CAP - 1) + '…' : s;
  };
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = cap(v);
    else if (typeof v === 'number' || typeof v === 'boolean' || v == null) out[k] = v;
    else { try { out[k] = cap(JSON.stringify(v)); } catch { out[k] = ''; } }
  }
  return out;
}

// The text of a tool_result's content (string, or the text/image blocks of an
// array), ANSI-stripped and capped. Images collapse to a `[image]` marker (the
// bytes aren't shipped). Used to attach a tool's OUTPUT to its tool_use.
function _resultText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c) => {
        if (!c) return '';
        if (c.type === 'text' && typeof c.text === 'string') return c.text;
        if (c.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  text = stripAnsi(text).trim();
  return text.length > TOOL_RESULT_CAP ? text.slice(0, TOOL_RESULT_CAP - 1) + '…' : text;
}

// Pull the tool_result blocks out of one JSONL line (they ride on user lines as
// plumbing). Returns [{ id: tool_use_id, text }]. PURE — unit-testable.
function extractToolResults(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    out.push({ id: b.tool_use_id, text: _resultText(b.content) });
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
//
// The paginator is AGENT-AGNOSTIC: chunking, line reassembly, the cursor codec and
// the tool_use<-tool_result pairing are identical for every coding agent, only the
// per-line JSON shape differs. `opts.parseLine` / `opts.extractResults` inject that
// shape (see lib/agents.js); both default to the Claude Code parsers below, so every
// existing caller is unaffected.
function scanTurnsBackward(readChunk, fileSize, opts = {}) {
  const limit = Math.max(1, Math.min(MAX_PAGE, opts.limit || DEFAULT_PAGE));
  const chunkSize = opts.chunkSize || SCAN_CHUNK;
  const parseLine = opts.parseLine || parseTranscriptTurn;
  const extractResults = opts.extractResults || extractToolResults;
  const end = (opts.before == null) ? fileSize : opts.before; // exclusive upper bound
  let bufStart = end;                 // buf holds bytes [bufStart, hi)
  let hi = end;
  let buf = Buffer.alloc(0);
  const turns = [];                   // newest-first
  let oldestStart = end;              // line-start offset of the oldest kept turn
  let reachedStart = false;
  const resultsById = new Map();      // tool_use_id -> output text (for rich cards)

  const take = (lineStart, lineBuf) => {
    const s = lineBuf.toString('utf8');
    // Scanning newest→oldest, a tool_result line is seen BEFORE its (older)
    // tool_use, so the map is ready to attach when the tool_use turn is built.
    for (const r of extractResults(s)) {
      if (!resultsById.has(r.id)) resultsById.set(r.id, r.text);
    }
    const turn = parseLine(s);
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

  // Attach each tool's captured output to its tool_use (by id).
  for (const t of turns) {
    for (const tu of t.toolUses || []) {
      if (tu.id && resultsById.has(tu.id)) tu.result = resultsById.get(tu.id);
    }
  }

  turns.reverse(); // newest-last for the chat view
  const hasMore = !reachedStart;
  const cursor = (hasMore && turns.length > 0) ? encodeCursor(oldestStart) : null;
  return { turns, cursor, hasMore };
}

// --- subagent trace: chat-mode parity with the terminal's subagent panel ------
// Claude Code stores each spawned subagent's OWN transcript beside the main one:
//   <projectsDir>/<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
// with a sidecar agent-<agentId>.meta.json:
//   { agentType, description, toolUseId, parentAgentId?, spawnDepth }
// where `toolUseId` === the parent Task tool_use `id` in the main transcript. So a
// Task card in the chat view can drill into that subagent's turns. Crucially the
// subagent .jsonl uses the SAME per-line turn shape as the main transcript, so
// scanTurnsBackward / parseTranscriptTurn parse it UNCHANGED — one parser, no
// duplication (SSOT). server.js supplies the file I/O (readdir + read the metas +
// chunk-read the agent .jsonl); the helpers here stay PURE and unit-testable.

const SUBAGENT_STR_CAP = 400; // agentType/description are short labels

function _saStr(s) {
  if (typeof s !== 'string') return '';
  const clean = stripAnsi(s);
  return clean.length > SUBAGENT_STR_CAP ? clean.slice(0, SUBAGENT_STR_CAP - 1) + '…' : clean;
}

// Parse one agent-*.meta.json text into { agentType, description, toolUseId } (all
// capped strings), or null when it's malformed or carries no toolUseId — without a
// toolUseId it can't be linked to a Task tool_use, so it's unusable here. PURE.
function parseAgentMeta(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const toolUseId = typeof obj.toolUseId === 'string' ? obj.toolUseId : '';
  if (!toolUseId) return null;
  return {
    agentType: _saStr(obj.agentType),
    description: _saStr(obj.description),
    toolUseId,
  };
}

// The set of tool_use_ids that already carry a tool_result in a block of transcript
// text (i.e. the tool has FINISHED). This is the one signal for whether a Task's
// subagent is still running: a Task with no tool_result yet is in flight. PURE.
function collectResolvedIds(text) {
  const set = new Set();
  if (typeof text !== 'string' || !text) return set;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    for (const r of extractToolResults(line)) set.add(r.id);
  }
  return set;
}

// Attach a lightweight subagent stub — { agentType, description, running } — to
// every tool_use in `turns` whose id resolves to a subagent meta (lookupMeta). The
// meta's toolUseId IS the spawning tool_use's id, so the id match — not the tool
// NAME — is the authoritative "this spawned a subagent" signal: the CLI names it
// `Task`, but other Claude Code hosts name it `Agent`, and gating on a name would
// silently miss those. A subagent is `running` when it has produced no result yet:
// neither an in-page tool_result (scanTurnsBackward set tu.result) NOR one in the
// resolved-id set (isResolved(id), typically built from the parent tail). The two
// sources together are robust on any page — the live tail (no result → running)
// and deep-history pages (finished long ago → resolved). PURE (predicates
// injected); mutates + returns `turns`.
function attachSubagentStubs(turns, lookupMeta, isResolved) {
  for (const t of turns || []) {
    for (const tu of (t && t.toolUses) || []) {
      if (!tu || !tu.id) continue;
      const meta = lookupMeta(tu.id);
      if (!meta) continue;
      const resolved = (tu.result != null) || !!(isResolved && isResolved(tu.id));
      tu.subagent = {
        agentType: meta.agentType || '',
        description: meta.description || '',
        running: !resolved,
      };
    }
  }
  return turns;
}

// --- #19: pending interactive question (AskUserQuestion) ---------------------
// Claude's AskUserQuestion is a tool call, so its full structure (questions,
// headers, options, multiSelect) is in the transcript as a `tool_use` block —
// no need to scrape the TUI screen. The companion app renders it as a native
// overlay. A question is PENDING until a matching `tool_result` (same
// tool_use_id) appears; once answered it stops being surfaced. PURE (text in,
// object out) so it's exhaustively unit-testable; server.js reads the tail.
const PQ_MAX_QUESTIONS = 10;
const PQ_MAX_OPTIONS = 24;
const PQ_STR_CAP = 800;

function _pqStr(s) {
  if (typeof s !== 'string') return '';
  const clean = stripAnsi(s);
  return clean.length > PQ_STR_CAP ? clean.slice(0, PQ_STR_CAP - 1) + '…' : clean;
}

// Shape an AskUserQuestion tool_use `input` into the app-facing question list,
// bounding counts/lengths and dropping malformed/empty entries.
function _shapeQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  const out = [];
  for (const q of qs.slice(0, PQ_MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') continue;
    const options = Array.isArray(q.options) ? q.options : [];
    const shaped = {
      header: _pqStr(q.header),
      question: _pqStr(q.question),
      multiSelect: q.multiSelect === true,
      options: options
        .slice(0, PQ_MAX_OPTIONS)
        .map(o => ({ label: _pqStr(o && o.label), description: _pqStr(o && o.description) }))
        .filter(o => o.label),
    };
    if (shaped.options.length > 0) out.push(shaped);
  }
  return out;
}

// Find the newest unanswered AskUserQuestion tool_use in a block of transcript
// text and return { toolUseId, questions } — or null when none is pending.
function pendingQuestion(text) {
  if (typeof text !== 'string' || !text) return null;
  const resolved = new Set();  // tool_use_ids that already have a tool_result
  const asks = [];             // { id, questions } in file order
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && typeof b.id === 'string') {
        const questions = _shapeQuestions(b.input);
        if (questions.length > 0) asks.push({ id: b.id, questions });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resolved.add(b.tool_use_id);
      }
    }
  }
  for (let i = asks.length - 1; i >= 0; i--) {
    if (!resolved.has(asks[i].id)) {
      return { toolUseId: asks[i].id, questions: asks[i].questions };
    }
  }
  return null;
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
  extractToolResults,
  encodeCursor,
  decodeCursor,
  stripAnsi,
  claudeProjectDirName,
  DEFAULT_PAGE,
  MAX_PAGE,
  // Shared sanitise/cap primitives. The per-agent parsers (lib/transcript-codex.js)
  // MUST reuse these rather than re-deriving the caps, so one turn/tool/result size
  // limit governs every agent's transcript.
  capTurnText: _capTurnText,
  capInput: _capInput,
  resultText: _resultText,
  // subagent trace (chat-mode parity with the terminal subagent panel)
  parseAgentMeta,
  collectResolvedIds,
  attachSubagentStubs,
  // #19 pending interactive question
  pendingQuestion,
  // Shape an AskUserQuestion tool_input into the app-facing question list. Used
  // by the live PreToolUse-hook path (server.js) as well as the transcript scan.
  shapeQuestions: _shapeQuestions,
};
