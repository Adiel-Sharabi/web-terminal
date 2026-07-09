'use strict';
// Codex CLI rollout-JSONL parser — the Codex counterpart of the Claude Code line
// parsers in lib/transcript.js. Emits the SAME typed turn shape
// ({role, text, toolUses, ts, ctxTokens}) so the companion chat view, the backward
// paginator and the wire contract stay agent-agnostic; only this file knows what a
// Codex line looks like. PURE (no fs) — exhaustively unit-testable.
//
// Verified against codex-cli 0.134.0 rollouts (~/.codex/sessions/YYYY/MM/DD/
// rollout-<iso>-<uuid>.jsonl). Every line is {timestamp, type, payload}:
//
//   type=session_meta   payload {id, cwd, cli_version, ...}   (first line, not a turn)
//   type=response_item  payload.type:
//        message                  {role: user|assistant|developer, content:[blocks]}
//        function_call            {name, arguments:<JSON string>, call_id}
//        function_call_output     {call_id, output:<string>}
//        custom_tool_call         {name, input:<string>, call_id}   e.g. apply_patch
//        custom_tool_call_output  {call_id, output:<JSON string {output, metadata}>}
//        reasoning                (thinking — not conversation)
//        web_search_call          {action:{query}}
//   type=event_msg      duplicates of the above (agent_message/user_message) plus
//                       token_count / task_started / task_complete
//   type=turn_context | compacted
//
// Two shapes differ from Claude and are normalised here so the app stays dumb:
//   * a tool's input arrives as a JSON *string* (`arguments`), not an object;
//   * a tool's output arrives as a plain *string*, not a content-block array.
//
// event_msg lines are SKIPPED: `agent_message`/`user_message` restate the text of a
// response_item.message, so parsing both would double every turn in the chat view.
const { stripAnsi, capTurnText, capInput, resultText } = require('./transcript');

// Content blocks carry `output_text` on assistant turns and `input_text` on user
// turns; plain `text` is accepted defensively in case the wire shape widens.
const _TEXT_BLOCKS = new Set(['output_text', 'input_text', 'text']);

function _blockText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && _TEXT_BLOCKS.has(b.type) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// A tool_use `input`. Codex ships it as a JSON string (`arguments`); when it doesn't
// parse to an object we keep the raw text under `input` so the card still shows it
// rather than silently dropping the only evidence of what the tool was asked to do.
function _inputFromArguments(args) {
  if (typeof args !== 'string') return capInput(args);
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return capInput(parsed);
  } catch { /* not JSON — fall through to the raw form */ }
  return capInput({ input: args });
}

const TOOL_PREVIEW_CAP = 80; // mirrors lib/transcript.js's chip preview budget

function _preview(value) {
  let s = '';
  try { s = typeof value === 'string' ? value : JSON.stringify(value == null ? {} : value); }
  catch { s = ''; }
  s = stripAnsi(s);
  return s.length > TOOL_PREVIEW_CAP ? s.slice(0, TOOL_PREVIEW_CAP - 1) + '…' : s;
}

function _toolUse(name, callId, input, preview) {
  return {
    name: typeof name === 'string' ? name : '',
    inputPreview: preview,
    id: typeof callId === 'string' ? callId : '',
    input,
  };
}

// One assistant turn carrying exactly one tool call. Codex writes every tool call as
// its OWN response_item line (Claude nests several tool_use blocks inside a single
// assistant message), so a Codex tool call becomes a text-less assistant turn.
function _toolTurn(toolUse, ts) {
  return { role: 'assistant', text: '', toolUses: [toolUse], ts, ctxTokens: null };
}

// The session_meta header line: {id, cwd, cliVersion, ts}, or null. This is the ONLY
// place a Codex rollout records its working directory — unlike Claude, whose project
// directory encodes the cwd in the path — so resolving "which rollout belongs to this
// session's cwd" means reading this line.
function parseSessionMeta(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || obj.type !== 'session_meta') return null;
  const p = obj.payload;
  if (!p || typeof p !== 'object') return null;
  return {
    id: typeof p.id === 'string' ? p.id : '',
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : '',
    ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
  };
}

// Parse ONE rollout line into a typed chat turn, or null when the line is not
// conversation (session_meta, event_msg, turn_context, reasoning, developer-role
// plumbing, tool OUTPUT lines, malformed JSON).
//
// ctxTokens is always null: Codex reports usage on separate `event_msg/token_count`
// lines rather than on the assistant turn, so associating the two needs scan-level
// state. Deliberately out of scope here — the app already treats null as "unknown".
function parseTranscriptTurn(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || obj.type !== 'response_item') return null;
  const p = obj.payload;
  if (!p || typeof p !== 'object') return null;
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;

  switch (p.type) {
    case 'message': {
      // `developer` carries the sandbox/permissions preamble — plumbing, not chat.
      if (p.role !== 'assistant' && p.role !== 'user') return null;
      const text = capTurnText(_blockText(p.content));
      if (!text) return null;
      return { role: p.role, text, toolUses: [], ts, ctxTokens: null };
    }
    case 'function_call':
      return _toolTurn(
        _toolUse(p.name, p.call_id, _inputFromArguments(p.arguments), _preview(p.arguments)),
        ts,
      );
    case 'custom_tool_call':
      // e.g. apply_patch — `input` is the raw patch body, not JSON.
      return _toolTurn(
        _toolUse(p.name, p.call_id, capInput({ input: p.input }), _preview(p.input)),
        ts,
      );
    case 'web_search_call': {
      const query = (p.action && typeof p.action.query === 'string') ? p.action.query : '';
      return _toolTurn(_toolUse('web_search', p.call_id, capInput({ query }), _preview(query)), ts);
    }
    default:
      return null; // reasoning / anything else is not conversation
  }
}

// A custom tool's output is a JSON *string* wrapping {output, metadata} (apply_patch
// reports its file list under `.output`). Unwrap to the human-readable part; anything
// that isn't that shape is passed through untouched.
function _unwrapCustomOutput(output) {
  if (typeof output !== 'string') return output;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') return parsed.output;
  } catch { /* plain string output */ }
  return output;
}

// Pull the tool OUTPUT off one line, keyed by the call_id that pairs it with its
// (older) tool call. Returns [{id, text}] — the shape scanTurnsBackward expects.
function extractToolResults(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || obj.type !== 'response_item') return [];
  const p = obj.payload;
  if (!p || typeof p !== 'object' || typeof p.call_id !== 'string') return [];
  if (p.type === 'function_call_output') return [{ id: p.call_id, text: resultText(p.output) }];
  if (p.type === 'custom_tool_call_output') {
    return [{ id: p.call_id, text: resultText(_unwrapCustomOutput(p.output)) }];
  }
  return [];
}

module.exports = {
  parseTranscriptTurn,
  extractToolResults,
  parseSessionMeta,
};
