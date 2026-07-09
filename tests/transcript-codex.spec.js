// @ts-check
// lib/transcript-codex.js — parses Codex CLI rollout JSONL into the same typed turn
// shape as the Claude Code parser, so the chat view and the backward paginator stay
// agent-agnostic. Shapes below were captured from real codex-cli 0.134.0 rollouts.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseTranscriptTurn, extractToolResults, parseSessionMeta,
} = require('../lib/transcript-codex');
const { scanTurnsBackward } = require('../lib/transcript');
const { getAdapter, detectAgentFromCommand, isKnownAgent } = require('../lib/agents');

// ---- line builders (mirror the real rollout wire shape) ---------------------
const line = (type, payload, timestamp = '2026-07-09T12:00:00.000Z') =>
  ({ timestamp, type, payload });
const msg = (role, text) =>
  line('response_item', { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const call = (name, args, callId) =>
  line('response_item', { type: 'function_call', name, arguments: args, call_id: callId });
const callOut = (callId, output) =>
  line('response_item', { type: 'function_call_output', call_id: callId, output });
const customCall = (name, input, callId) =>
  line('response_item', { type: 'custom_tool_call', name, input, call_id: callId });
const customOut = (callId, output) =>
  line('response_item', { type: 'custom_tool_call_output', call_id: callId, output });

const S = (o) => JSON.stringify(o);

// In-memory chunk reader for scanTurnsBackward (mirrors server.js's fs reader).
function memReader(lineObjs) {
  const data = Buffer.from(lineObjs.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { read: (off, len) => data.slice(off, off + len), size: data.length };
}

const CODEX = getAdapter('codex');
const scanCodex = (reader, opts = {}) =>
  scanTurnsBackward(reader.read, reader.size, { parseLine: CODEX.parseLine, extractResults: CODEX.extractResults, ...opts });

// ---- session_meta -----------------------------------------------------------
test('parseSessionMeta pulls id + cwd (the only record of the working dir)', () => {
  const meta = parseSessionMeta(S(line('session_meta', {
    id: '019f4645-4cae-7252-943a-87e5b2140364',
    cwd: 'C:\\dev\\web-terminal',
    cli_version: '0.134.0',
  })));
  expect(meta).toEqual({
    id: '019f4645-4cae-7252-943a-87e5b2140364',
    cwd: 'C:\\dev\\web-terminal',
    cliVersion: '0.134.0',
    ts: '2026-07-09T12:00:00.000Z',
  });
});

test('parseSessionMeta returns null for non-meta and malformed lines', () => {
  expect(parseSessionMeta(S(msg('assistant', 'hi')))).toBeNull();
  expect(parseSessionMeta('{not json')).toBeNull();
});

// ---- messages ---------------------------------------------------------------
test('assistant output_text and user input_text become turns', () => {
  expect(parseTranscriptTurn(S(msg('assistant', 'Hello')))).toEqual({
    role: 'assistant', text: 'Hello', toolUses: [], ts: '2026-07-09T12:00:00.000Z', ctxTokens: null,
  });
  expect(parseTranscriptTurn(S(msg('user', 'Hi there')))).toMatchObject({ role: 'user', text: 'Hi there' });
});

test('developer-role preamble is plumbing, not conversation', () => {
  expect(parseTranscriptTurn(S(msg('developer', '<permissions instructions>')))).toBeNull();
});

test('non-conversation lines are skipped', () => {
  expect(parseTranscriptTurn(S(line('response_item', { type: 'reasoning', summary: [] })))).toBeNull();
  expect(parseTranscriptTurn(S(line('event_msg', { type: 'agent_message', message: 'dup' })))).toBeNull();
  expect(parseTranscriptTurn(S(line('event_msg', { type: 'token_count' })))).toBeNull();
  expect(parseTranscriptTurn(S(line('turn_context', {})))).toBeNull();
  expect(parseTranscriptTurn(S(line('session_meta', { id: 'x', cwd: 'y' })))).toBeNull();
  expect(parseTranscriptTurn('{not json')).toBeNull();
  expect(parseTranscriptTurn(S(msg('assistant', '   ')))).toBeNull(); // empty text
});

test('event_msg duplicates of a message do not double the turn', () => {
  const r = memReader([
    msg('assistant', 'Only once'),
    line('event_msg', { type: 'agent_message', message: 'Only once' }),
  ]);
  const { turns } = scanCodex(r);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe('Only once');
});

// ---- tool calls -------------------------------------------------------------
test('function_call becomes a text-less assistant turn with a parsed input object', () => {
  const turn = parseTranscriptTurn(S(call('shell_command', '{"command":"npm test"}', 'call_1')));
  expect(turn.role).toBe('assistant');
  expect(turn.text).toBe('');
  expect(turn.toolUses).toHaveLength(1);
  expect(turn.toolUses[0]).toMatchObject({
    name: 'shell_command',
    id: 'call_1',
    input: { command: 'npm test' }, // arguments arrive as a JSON *string*, normalised here
  });
});

test('unparseable function_call arguments are preserved as raw input, not dropped', () => {
  const turn = parseTranscriptTurn(S(call('shell_command', 'not-json', 'call_2')));
  expect(turn.toolUses[0].input).toEqual({ input: 'not-json' });
});

test('custom_tool_call (apply_patch) keeps the raw patch body', () => {
  const patch = '*** Begin Patch\n*** Add File: a.md\n+hello\n';
  const turn = parseTranscriptTurn(S(customCall('apply_patch', patch, 'call_3')));
  expect(turn.toolUses[0]).toMatchObject({ name: 'apply_patch', id: 'call_3', input: { input: patch } });
});

test('web_search_call surfaces its query', () => {
  const turn = parseTranscriptTurn(S(line('response_item', {
    type: 'web_search_call', call_id: 'call_4', action: { type: 'search', query: 'codex hooks' },
  })));
  expect(turn.toolUses[0]).toMatchObject({ name: 'web_search', input: { query: 'codex hooks' } });
});

test('tool inputPreview is capped and ANSI-stripped', () => {
  const ESC = String.fromCharCode(0x1b); // never a raw byte in source
  const dirty = ESC + '[31m' + 'x'.repeat(200);
  const turn = parseTranscriptTurn(S(call('shell_command', dirty, 'call_5')));
  const preview = turn.toolUses[0].inputPreview;
  expect(preview).toHaveLength(80);
  expect(preview.endsWith('…')).toBe(true);
  expect(preview).not.toContain(ESC);
});

// ---- tool results -----------------------------------------------------------
test('function_call_output is keyed by call_id', () => {
  expect(extractToolResults(S(callOut('call_1', 'Exit code: 0')))).toEqual([{ id: 'call_1', text: 'Exit code: 0' }]);
});

test('custom_tool_call_output unwraps its JSON {output, metadata} envelope', () => {
  const enveloped = JSON.stringify({ output: 'Success. Updated a.md', metadata: { exit_code: 0 } });
  expect(extractToolResults(S(customOut('call_3', enveloped)))).toEqual([{ id: 'call_3', text: 'Success. Updated a.md' }]);
});

test('a custom output that is not the envelope shape passes through untouched', () => {
  expect(extractToolResults(S(customOut('call_3', 'plain text')))).toEqual([{ id: 'call_3', text: 'plain text' }]);
});

test('lines carrying no tool output yield nothing', () => {
  expect(extractToolResults(S(msg('assistant', 'hi')))).toEqual([]);
  expect(extractToolResults('{not json')).toEqual([]);
});

// ---- paginator integration --------------------------------------------------
test('scanTurnsBackward pairs a Codex tool call with its output and orders newest-last', () => {
  const r = memReader([
    msg('user', 'run the tests'),
    call('shell_command', '{"command":"npm test"}', 'call_1'),
    callOut('call_1', 'Exit code: 0'),
    msg('assistant', 'All green'),
  ]);
  const { turns, hasMore, cursor } = scanCodex(r);
  expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(turns[0].text).toBe('run the tests');
  expect(turns[1].toolUses[0].result).toBe('Exit code: 0'); // paired across lines by call_id
  expect(turns[2].text).toBe('All green');
  expect(hasMore).toBe(false);
  expect(cursor).toBeNull();
});

test('scanTurnsBackward paginates Codex turns backward with an opaque cursor', () => {
  const r = memReader([msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three')]);
  const page1 = scanCodex(r, { limit: 2 });
  expect(page1.turns.map((t) => t.text)).toEqual(['two', 'three']);
  expect(page1.hasMore).toBe(true);
  const page2 = scanCodex(r, { limit: 2, before: Number(Buffer.from(page1.cursor, 'base64').toString('utf8')) });
  expect(page2.turns.map((t) => t.text)).toEqual(['one']);
  expect(page2.hasMore).toBe(false);
});

test('the paginator still defaults to the Claude parsers when none are injected', () => {
  const claudeLines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
  ];
  const r = memReader(claudeLines);
  const { turns } = scanTurnsBackward(r.read, r.size, {});
  expect(turns.map((t) => t.text)).toEqual(['hi', 'hello']);
});

// ---- adapter registry -------------------------------------------------------
test('detectAgentFromCommand recognises an agent only as a bare program name', () => {
  for (const cmd of ['codex', 'codex --resume', 'C:\\bin\\codex.exe -c x', 'npx codex', '/usr/bin/codex']) {
    expect(detectAgentFromCommand(cmd)).toBe('codex');
  }
  for (const cmd of ['claude', 'claude --resume abc', 'C:\\bin\\claude.cmd']) {
    expect(detectAgentFromCommand(cmd)).toBe('claude');
  }
  // A plain shell runs no agent. Null is a real answer — it must NOT be coerced to
  // claude, or a pwsh session gets tinted and scanned as though it were Claude.
  for (const cmd of ['pwsh', 'bash', 'codex-notes', 'my-codex', 'echo codexy', 'myclaude', '', null, undefined]) {
    expect(detectAgentFromCommand(cmd)).toBeNull();
  }
});

test('getAdapter falls back to claude for unknown ids rather than throwing', () => {
  expect(getAdapter('codex').id).toBe('codex');
  expect(getAdapter('claude').id).toBe('claude');
  expect(getAdapter('nope').id).toBe('claude');
  expect(getAdapter(undefined).id).toBe('claude');
  expect(isKnownAgent('codex')).toBe(true);
  expect(isKnownAgent('nope')).toBe(false);
});

test('codex transcripts are contained under ~/.codex/sessions', () => {
  expect(getAdapter('codex').transcriptDir).toEqual(['.codex', 'sessions']);
  expect(getAdapter('claude').transcriptDir).toEqual(['.claude', 'projects']);
});

// ---- smoke test against a REAL rollout on this machine ----------------------
// Proves the parser against bytes Codex actually wrote, not just hand-built shapes.
// Skipped on machines with no Codex history.
function newestRollout() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  walk(root);
  if (!found.length) return null;
  return found.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
}

test('parses a real Codex rollout end to end', () => {
  const file = newestRollout();
  test.skip(!file, 'no Codex rollouts on this machine');
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  const meta = parseSessionMeta(raw[0]);
  expect(meta, 'first line is session_meta').not.toBeNull();
  expect(meta.cwd.length).toBeGreaterThan(0);
  expect(meta.id.length).toBeGreaterThan(0);

  const turns = raw.map(parseTranscriptTurn).filter(Boolean);
  expect(turns.length).toBeGreaterThan(0);
  for (const t of turns) {
    expect(['user', 'assistant']).toContain(t.role);
    expect(typeof t.text).toBe('string');
    expect(Array.isArray(t.toolUses)).toBe(true);
    // Every tool call must be pairable with its output, or the chat card shows no result.
    for (const tu of t.toolUses) expect(tu.id).not.toBe('');
  }

  // Whatever tool outputs the file contains must key onto ids the parser emitted.
  // A compacted session drops older lines, so an output can outlive its call — only
  // assert total pairing when this rollout was never compacted.
  const compacted = raw.some((l) => { try { return JSON.parse(l).type === 'compacted'; } catch { return false; } });
  const callIds = new Set(turns.flatMap((t) => t.toolUses.map((tu) => tu.id)));
  const resultIds = raw.flatMap(extractToolResults).map((r) => r.id);
  if (!compacted) for (const id of resultIds) expect(callIds.has(id)).toBe(true);
});
