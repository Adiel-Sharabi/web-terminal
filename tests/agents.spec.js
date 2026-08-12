// @ts-check
// lib/agents.js — the AI-agent provider registry. Everything agent-specific lives
// here; these tests pin the contract that lets a new CLI agent be added as one entry.
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  getAdapter, isKnownAgent, detectAgentFromCommand, commandLaunches, resolveAgent,
  resolveTranscriptFor, listProviders, DEFAULT_AGENT, AGENT_IDS,
} = require('../lib/agents');

const BS = String.fromCharCode(92);

// ---- registry contract ------------------------------------------------------
test('every provider satisfies the interface downstream code relies on', () => {
  expect(AGENT_IDS.length).toBeGreaterThanOrEqual(2);
  for (const id of AGENT_IDS) {
    const p = getAdapter(id);
    expect(p.id).toBe(id);
    expect(typeof p.label).toBe('string');
    expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof p.detect).toBe('function');
    expect(Array.isArray(p.transcriptDir)).toBe(true);
    expect(p.transcriptDir.length).toBeGreaterThan(0);
    expect(typeof p.parseLine).toBe('function');
    expect(typeof p.extractResults).toBe('function');
    expect(typeof p.resolveTranscript).toBe('function');
    expect(typeof p.supportsSubagentTrace).toBe('boolean');
  }
});

test('getAdapter falls back to the default for unknown ids rather than throwing', () => {
  expect(getAdapter('codex').id).toBe('codex');
  expect(getAdapter('nope').id).toBe(DEFAULT_AGENT);
  expect(getAdapter(undefined).id).toBe(DEFAULT_AGENT);
  expect(getAdapter(null).id).toBe(DEFAULT_AGENT);
  expect(isKnownAgent('codex')).toBe(true);
  expect(isKnownAgent('nope')).toBe(false);
  expect(isKnownAgent(null)).toBe(false);
});

test('listProviders is the catalogue the picker and tinting render', () => {
  const list = listProviders();
  expect(list.map((p) => p.id).sort()).toEqual([...AGENT_IDS].sort());
  for (const p of list) expect(Object.keys(p).sort()).toEqual(['color', 'id', 'label']);
});

test('commandLaunches answers "is this a claude session" without a local regex', () => {
  expect(commandLaunches('claude', 'claude --resume abc')).toBe(true);
  expect(commandLaunches('claude', 'pwsh')).toBe(false);
  expect(commandLaunches('codex', 'npx codex')).toBe(true);
  expect(commandLaunches('nope', 'anything')).toBe(false);
});

// ---- resolveAgent: the one composition every endpoint owes (#119) -----------
test('resolveAgent prefers the explicit pick and falls back to inference', () => {
  expect(resolveAgent('codex', 'claude --resume abc')).toBe('codex');
  expect(resolveAgent(null, 'claude --resume abc')).toBe('claude');
  expect(resolveAgent('', 'npx codex')).toBe('codex');
  expect(resolveAgent(undefined, 'pwsh')).toBeNull();
  // An unknown id is never persisted (create rejects it) but must still degrade to
  // inference rather than through — a session written by a NEWER server loads here.
  expect(resolveAgent('skynet', 'claude')).toBe('claude');
  expect(resolveAgent(null, null)).toBeNull();
});

// ---- per-provider transcript resolution -------------------------------------
// Claude derives its path from the cwd + its conversation id; Codex must search.
const claudeIo = { root: 'ROOT', join: path.join, listRollouts: () => [], readFirstLine: () => '' };

test('claude resolves a path purely from cwd + conversation id', () => {
  const p = getAdapter('claude').resolveTranscript(
    { cwd: 'C:' + BS + 'dev' + BS + 'Acme_Core', agentSessionId: 'sid-1' }, claudeIo,
  );
  // Every non-alphanumeric char of the cwd becomes '-', per claudeProjectDirName.
  expect(p).toBe(path.join('ROOT', 'C--dev-Acme-Core', 'sid-1.jsonl'));
});

test('claude resolves nothing without a conversation id (a fresh session)', () => {
  expect(getAdapter('claude').resolveTranscript({ cwd: 'C:' + BS + 'dev', agentSessionId: null }, claudeIo)).toBe('');
  expect(getAdapter('claude').resolveTranscript({ cwd: '', agentSessionId: 'x' }, claudeIo)).toBe('');
});

// A session's cwd is where its SHELL started, not where the agent RUNS. Resuming another
// project's conversation from inside the TUI (or a plain cd) puts the transcript under a
// different project dir, and the derivation then names a file that does not exist —
// observed on XPS: session cwd C:\dev\AM8_Core, conversation under C--dev-am8-health.
test('claude falls back to an exact by-id lookup when the cwd derivation misses', () => {
  const real = path.join('ROOT', 'C--dev-am8-health', 'sid-9.jsonl');
  const io = {
    root: 'ROOT', join: path.join, listRollouts: () => [], readFirstLine: () => '',
    exists: (p) => p === real,
    findByBasename: (n) => (n === 'sid-9.jsonl' ? real : ''),
  };
  const p = getAdapter('claude').resolveTranscript(
    { cwd: 'C:' + BS + 'dev' + BS + 'AM8_Core', agentSessionId: 'sid-9' }, io,
  );
  expect(p).toBe(real);
});

// The fallback must stay OFF the common path: one path join, no directory walk.
test('claude prefers the cwd derivation and does not search when that file exists', () => {
  let searched = 0;
  const io = {
    root: 'ROOT', join: path.join, listRollouts: () => [], readFirstLine: () => '',
    exists: () => true,
    findByBasename: () => { searched++; return path.join('ROOT', 'elsewhere', 'sid-1.jsonl'); },
  };
  const p = getAdapter('claude').resolveTranscript(
    { cwd: 'C:' + BS + 'dev' + BS + 'Acme_Core', agentSessionId: 'sid-1' }, io,
  );
  expect(p).toBe(path.join('ROOT', 'C--dev-Acme-Core', 'sid-1.jsonl'));
  expect(searched).toBe(0);
});

test('claude resolves nothing when the conversation id exists nowhere', () => {
  const io = {
    root: 'ROOT', join: path.join, listRollouts: () => [], readFirstLine: () => '',
    exists: () => false, findByBasename: () => '',
  };
  expect(getAdapter('claude').resolveTranscript(
    { cwd: 'C:' + BS + 'dev', agentSessionId: 'ghost' }, io,
  )).toBe('');
});

test('codex resolves by searching rollout heads for a matching cwd', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const head = (c) => JSON.stringify({ type: 'session_meta', payload: { id: 'u', cwd: c } });
  const io = {
    root: 'ROOT', join: path.join,
    listRollouts: () => [{ path: 'old.jsonl', mtimeMs: 1 }, { path: 'new.jsonl', mtimeMs: 9 }],
    readFirstLine: (p) => (p === 'new.jsonl' ? head(cwd) : head('C:' + BS + 'other')),
  };
  expect(getAdapter('codex').resolveTranscript({ cwd }, io)).toBe('new.jsonl');
  expect(getAdapter('codex').resolveTranscript({ cwd: 'C:' + BS + 'nope' }, io)).toBe('');
});

// ---- resolveTranscriptFor: preferred first, then discovery ------------------
// makeIo/validate are the seams server.js fills with real fs + the containment gate.
function harness(hits, { rejectAll = false } = {}) {
  const tried = [];
  const makeIo = (provider) => ({ root: provider.id + '-root', join: path.join, listRollouts: () => [], readFirstLine: () => '' });
  const validate = (p) => (rejectAll ? '' : p);
  const providers = {};
  for (const id of AGENT_IDS) providers[id] = hits[id] || '';
  // Stub each provider's resolveTranscript by wrapping resolveTranscriptFor's inputs.
  const session = { cwd: 'C:' + BS + 'x', agentSessionId: 'sid' };
  return { tried, makeIo, validate, session, providers };
}

test('an explicit agent is tried first and wins', () => {
  const order = [];
  const makeIo = (p) => { order.push(p.id); return { root: 'r', join: path.join, listRollouts: () => [], readFirstLine: () => '' }; };
  const res = resolveTranscriptFor({ cwd: 'C:' + BS + 'x', agentSessionId: 'sid' }, 'codex', makeIo, () => '');
  expect(order[0]).toBe('codex'); // preferred provider consulted before any other
  expect(res.path).toBe('');
  expect(res.agent).toBe('codex'); // agent preserved even when nothing resolved
});

test('a session with no recorded agent still DISCOVERS a transcript from another provider', () => {
  // Claude (the preferred default) resolves nothing — no conversation id. Codex finds one.
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'u', cwd } });
  const makeIo = () => ({
    root: 'r', join: path.join,
    listRollouts: () => [{ path: 'roll.jsonl', mtimeMs: 1 }],
    readFirstLine: () => head,
  });
  const res = resolveTranscriptFor({ cwd, agentSessionId: null }, DEFAULT_AGENT, makeIo, (p) => p);
  expect(res).toEqual({ path: 'roll.jsonl', agent: 'codex' });
});

test('an EXPLICIT agent never falls through to another provider', () => {
  // Codex would happily resolve this cwd, but the session declares itself Claude.
  // Showing a Codex conversation on a Claude session is worse than showing none.
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'u', cwd } });
  const consulted = [];
  const makeIo = (p) => {
    consulted.push(p.id);
    return { root: 'r', join: path.join, listRollouts: () => [{ path: 'roll.jsonl', mtimeMs: 1 }], readFirstLine: () => head };
  };
  const res = resolveTranscriptFor({ cwd, agentSessionId: null }, 'claude', makeIo, (p) => p, { discover: false });
  expect(consulted).toEqual(['claude']); // codex never consulted
  expect(res).toEqual({ path: '', agent: 'claude' });
});

test('a candidate rejected by the containment gate is never returned', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'u', cwd } });
  const makeIo = () => ({
    root: 'r', join: path.join,
    listRollouts: () => [{ path: 'roll.jsonl', mtimeMs: 1 }],
    readFirstLine: () => head,
  });
  const res = resolveTranscriptFor({ cwd, agentSessionId: null }, DEFAULT_AGENT, makeIo, () => ''); // gate rejects everything
  expect(res.path).toBe('');
});

test('a provider that throws does not abort the search', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'u', cwd } });
  const makeIo = (p) => {
    if (p.id === DEFAULT_AGENT) throw new Error('io exploded');
    return { root: 'r', join: path.join, listRollouts: () => [{ path: 'roll.jsonl', mtimeMs: 1 }], readFirstLine: () => head };
  };
  const res = resolveTranscriptFor({ cwd, agentSessionId: 'sid' }, DEFAULT_AGENT, makeIo, (p) => p);
  expect(res).toEqual({ path: 'roll.jsonl', agent: 'codex' });
});

test('an unknown preferred agent degrades to the default instead of throwing', () => {
  const res = resolveTranscriptFor({ cwd: 'C:' + BS + 'x', agentSessionId: null }, 'nope',
    () => ({ root: 'r', join: path.join, listRollouts: () => [], readFirstLine: () => '' }), () => '');
  expect(res.agent).toBe(DEFAULT_AGENT);
  expect(res.path).toBe('');
});

test('only claude advertises a sibling subagent directory to index', () => {
  expect(getAdapter('claude').supportsSubagentTrace).toBe(true);
  expect(getAdapter('codex').supportsSubagentTrace).toBe(false);
});
