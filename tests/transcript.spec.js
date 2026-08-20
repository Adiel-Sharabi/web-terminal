// @ts-check
// lib/transcript.js — pulls Claude's last assistant message out of a Claude Code
// transcript JSONL so a phone push can quote what Claude actually said/asked.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  lastAssistantText, isAllowedTranscriptPath,
  parseTranscriptTurn, scanTurnsBackward, encodeCursor, decodeCursor, stripAnsi,
  extractToolResults, pendingQuestion, shapeQuestions, claudeProjectDirName,
  parseAgentMeta, collectResolvedIds, attachSubagentStubs, PQ_PREVIEW_CAP,
  PQ_MAX_OPTIONS,
} = require('../lib/transcript');

// In-memory chunk reader for scanTurnsBackward (mirrors server.js's fs reader).
function memReader(lineObjs) {
  const data = Buffer.from(lineObjs.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { read: (off, len) => data.slice(off, off + len), size: data.length };
}

// Write lines (objects) as JSONL to a unique temp file; returns the path.
let _n = 0;
function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `wt_transcript_${process.pid}_${++_n}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}
const asst = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const user = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

// #42: cwd -> Claude project-dir encoding. The ONE encoder both server.js and
// pty-worker.js use to resolve a session's transcript. The old inline copies only
// mapped '\'/'/', leaving '_'/'.'/space intact, so those cwds resolved to a
// non-existent dir and Chat vanished. Ground truth taken from real dir names in
// ~/.claude/projects.
test.describe('lib/transcript.claudeProjectDirName', () => {
  test('maps the reported bug case: C:\\dev\\Acme_Core -> C--dev-Acme-Core', () => {
    // Was C--dev-Acme_Core under the old encoder (underscore kept) -> 404 -> no Chat.
    expect(claudeProjectDirName('C:\\dev\\Acme_Core')).toBe('C--dev-Acme-Core');
  });
  test('replaces EVERY non-alphanumeric char (dot, space, underscore), case preserved, runs not collapsed', () => {
    expect(claudeProjectDirName('C:\\dev\\web-terminal')).toBe('C--dev-web-terminal');
    expect(claudeProjectDirName('C:\\dev\\acme\\.claude-tmp')).toBe('C--dev-acme--claude-tmp'); // '\.' -> '--'
    expect(claudeProjectDirName('C:\\Users\\a b\\My.Proj')).toBe('C--Users-a-b-My-Proj');
    expect(claudeProjectDirName('/home/user/App_v2')).toBe('-home-user-App-v2');
  });
  test('non-string / empty input -> empty string (never throws)', () => {
    expect(claudeProjectDirName('')).toBe('');
    expect(claudeProjectDirName(null)).toBe('');
    expect(claudeProjectDirName(undefined)).toBe('');
  });
});

test.describe('lib/transcript.lastAssistantText', () => {
  test('returns the newest assistant text turn', () => {
    const p = writeTranscript([
      user('do the thing'),
      asst('Working on it.'),
      user('and this too'),
      asst('All done — 23 tests pass.'),
    ]);
    try { expect(lastAssistantText(p)).toBe('All done — 23 tests pass.'); }
    finally { fs.unlinkSync(p); }
  });

  test('skips a trailing tool-use-only assistant turn to find the last prose', () => {
    const p = writeTranscript([
      asst('Let me run the tests.'),
      // assistant turn with only a tool_use block → no text → skipped
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    ]);
    try { expect(lastAssistantText(p)).toBe('Let me run the tests.'); }
    finally { fs.unlinkSync(p); }
  });

  test('ignores user turns entirely', () => {
    const p = writeTranscript([asst('The answer is 42.'), user('thanks!')]);
    try { expect(lastAssistantText(p)).toBe('The answer is 42.'); }
    finally { fs.unlinkSync(p); }
  });

  test('joins multiple text blocks in one turn', () => {
    const p = writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'First.' }, { type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Second.' },
      ] } },
    ]);
    try { expect(lastAssistantText(p)).toBe('First. Second.'); }
    finally { fs.unlinkSync(p); }
  });

  test('truncates long messages with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const p = writeTranscript([asst(long)]);
    try {
      const out = lastAssistantText(p, 200);
      expect(out.length).toBe(200);
      expect(out.endsWith('…')).toBe(true);
    } finally { fs.unlinkSync(p); }
  });

  test('collapses whitespace/newlines in the message', () => {
    const p = writeTranscript([asst('line one\n   line two\t\tend')]);
    try { expect(lastAssistantText(p)).toBe('line one line two end'); }
    finally { fs.unlinkSync(p); }
  });

  test('tolerates malformed JSON lines (skips them)', () => {
    const p = path.join(os.tmpdir(), `wt_transcript_bad_${process.pid}_${++_n}.jsonl`);
    fs.writeFileSync(p, [JSON.stringify(asst('good line')), '{not valid json', ''].join('\n'), 'utf8');
    try { expect(lastAssistantText(p)).toBe('good line'); }
    finally { fs.unlinkSync(p); }
  });

  test('returns "" for a missing file, empty path, or transcript with no assistant text', () => {
    expect(lastAssistantText('')).toBe('');
    expect(lastAssistantText(undefined)).toBe('');
    expect(lastAssistantText(path.join(os.tmpdir(), 'definitely-not-here-xyz.jsonl'))).toBe('');
    const p = writeTranscript([user('only user turns here')]);
    try { expect(lastAssistantText(p)).toBe(''); }
    finally { fs.unlinkSync(p); }
  });
});

// M1: pure containment/extension gate. It receives ALREADY-realpath'd paths from
// server.js (safeTranscriptPath), so a '..' traversal shows up here as a resolved
// path that no longer sits under the root. `platform` is injected so both OS rules
// are testable on any host.
test.describe('lib/transcript.isAllowedTranscriptPath', () => {
  const ROOT_NIX = '/home/u/.claude/projects';
  const ROOT_WIN = 'C:\\Users\\u\\.claude\\projects';

  test('accepts a .jsonl strictly under the root (posix)', () => {
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/proj/x.jsonl`, ROOT_NIX, 'linux')).toBe(true);
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/a/b/c.jsonl`, ROOT_NIX, 'linux')).toBe(true);
  });

  test('accepts under a root written with a trailing separator', () => {
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/proj/x.jsonl`, ROOT_NIX + '/', 'linux')).toBe(true);
  });

  test('win32: mixed separators + differing case are still contained', () => {
    expect(isAllowedTranscriptPath('C:/Users/U/.CLAUDE/projects/proj/X.JSONL', ROOT_WIN, 'win32')).toBe(true);
    expect(isAllowedTranscriptPath('c:\\users\\u\\.claude\\projects\\p\\x.jsonl', ROOT_WIN, 'win32')).toBe(true);
  });

  test('rejects a wrong / doubled extension', () => {
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/proj/x.txt`, ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/proj/x.jsonl.txt`, ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/proj/xjsonl`, ROOT_NIX, 'linux')).toBe(false);
  });

  test('rejects a path resolving OUTSIDE the root (traversal outcome)', () => {
    expect(isAllowedTranscriptPath('/home/u/.claude/secrets/x.jsonl', ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath('/etc/passwd.jsonl', ROOT_NIX, 'linux')).toBe(false);
  });

  test('rejects the root itself (must be a file strictly inside)', () => {
    expect(isAllowedTranscriptPath(ROOT_NIX, ROOT_NIX, 'linux')).toBe(false);
  });

  test('rejects a prefix-collision sibling dir (root /a/b vs /a/b-evil/x.jsonl)', () => {
    expect(isAllowedTranscriptPath('/a/b-evil/x.jsonl', '/a/b', 'linux')).toBe(false);
    expect(isAllowedTranscriptPath('C:\\a\\b-evil\\x.jsonl', 'C:\\a\\b', 'win32')).toBe(false);
  });

  test('posix is case-sensitive (a case-mismatched root is a different dir)', () => {
    expect(isAllowedTranscriptPath('/HOME/u/.claude/projects/p/x.jsonl', ROOT_NIX, 'linux')).toBe(false);
  });

  test('rejects non-string / empty inputs', () => {
    expect(isAllowedTranscriptPath(null, ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath(undefined, ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath(123, ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath('', ROOT_NIX, 'linux')).toBe(false);
    expect(isAllowedTranscriptPath(`${ROOT_NIX}/x.jsonl`, '', 'linux')).toBe(false);
  });
});

// ============================================================
// G5: structured transcript — parseTranscriptTurn (pure, one JSONL line → turn)
// ============================================================
const ESC = String.fromCharCode(0x1b); // keep raw ESC bytes out of this source
const jl = (o) => JSON.stringify(o);
const asstLine = (blocks, extra = {}) => jl({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });
const userLine = (content, extra = {}) => jl({ type: 'user', message: { role: 'user', content }, ...extra });

test.describe('lib/transcript.parseTranscriptTurn', () => {
  test('assistant text-only turn → role/text, empty toolUses, null ts', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: 'Hello there.' }]));
    expect(turn).toEqual({ role: 'assistant', text: 'Hello there.', toolUses: [], ts: null, ctxTokens: null });
  });

  test('assistant turn exposes ctxTokens = input + both cache tiers', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: 'hi' }], {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1200, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800 },
      },
    }));
    expect(turn.ctxTokens).toBe(42000);
  });

  test('assistant turn without a usage block → ctxTokens null', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: 'hi' }]));
    expect(turn.ctxTokens).toBeNull();
  });

  test('assistant turn with text + tool_use → both captured; preview is stringified input', () => {
    const turn = parseTranscriptTurn(asstLine([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]));
    expect(turn.role).toBe('assistant');
    expect(turn.text).toBe('Running it.');
    expect(turn.toolUses).toEqual([
      { name: 'Bash', inputPreview: '{"command":"npm test"}', id: '', input: { command: 'npm test' } },
    ]);
  });

  test('assistant tool_use-ONLY turn is KEPT (text empty, toolUses populated)', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'tool_use', name: 'Read', input: { file: 'a.js' } }]));
    expect(turn.role).toBe('assistant');
    expect(turn.text).toBe('');
    expect(turn.toolUses).toEqual([
      { name: 'Read', inputPreview: '{"file":"a.js"}', id: '', input: { file: 'a.js' } },
    ]);
  });

  test('tool_use exposes id + structured input (for rich chat cards)', () => {
    const turn = parseTranscriptTurn(asstLine([
      { type: 'tool_use', id: 'tu_9', name: 'Task',
        input: { description: 'find bug', subagent_type: 'search' } },
    ]));
    expect(turn.toolUses[0].id).toBe('tu_9');
    expect(turn.toolUses[0].input).toEqual({ description: 'find bug', subagent_type: 'search' });
  });

  test('a huge tool input string field is capped', () => {
    const turn = parseTranscriptTurn(asstLine([
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x'.repeat(5000) } },
    ]));
    expect(turn.toolUses[0].input.command.length).toBe(2000);
    expect(turn.toolUses[0].input.command.endsWith('…')).toBe(true);
  });

  test('assistant turn with neither text nor tool_use → null (skipped)', () => {
    expect(parseTranscriptTurn(asstLine([{ type: 'thinking', thinking: 'hmm' }]))).toBeNull();
  });

  test('inputPreview is capped at 80 chars with an ellipsis', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(300) } }]));
    expect(turn.toolUses[0].inputPreview.length).toBe(80);
    expect(turn.toolUses[0].inputPreview.endsWith('…')).toBe(true);
  });

  test('user turn with string content → text extracted', () => {
    expect(parseTranscriptTurn(userLine('do the thing'))).toEqual({ role: 'user', text: 'do the thing', typedText: 'do the thing', toolUses: [], ts: null });
  });

  // #149 — the chat lens's optimistic "Queued" echo has to recognise its own
  // prompt coming back, and the RAW text of a real prompt is never the text that
  // was typed: the harness staples injected context onto it, and a typed slash
  // command arrives as a tag trio. So the turn carries what was typed alongside
  // what is readable. `''` (not absent) is the positive statement "a human typed
  // nothing here", which is what stops an echo matching a teammate message.
  test('user turn publishes typedText with the injected context stripped', () => {
    const turn = parseTranscriptTurn(userLine(
      'fix the login bug\n<system-reminder>\nlots of injected instructions\n</system-reminder>'));
    expect(turn.text).toContain('<system-reminder>'); // `text` is still verbatim
    expect(turn.typedText).toBe('fix the login bug');
  });

  test('a user turn the human did not type publishes typedText as an empty string', () => {
    const turn = parseTranscriptTurn(userLine(
      '<task-notification><summary>Agent "search" finished</summary><result>found it</result></task-notification>'));
    expect(turn.role).toBe('user');
    expect(turn.typedText).toBe('');
  });

  test('an assistant turn never carries typedText', () => {
    // Only a user turn can be something a human typed. Publishing it on an
    // assistant turn would let an echo match the agent's own words.
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: 'do the thing' }]));
    expect(turn.role).toBe('assistant');
    expect('typedText' in turn).toBe(false);
  });

  test('user turn with text blocks → joined text', () => {
    const turn = parseTranscriptTurn(userLine([{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]));
    expect(turn.role).toBe('user');
    expect(turn.text).toBe('line one\nline two');
  });

  test('user tool_result-ONLY line → null (plumbing, skipped)', () => {
    expect(parseTranscriptTurn(userLine([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]))).toBeNull();
  });

  test('malformed JSON → null', () => {
    expect(parseTranscriptTurn('{not json')).toBeNull();
    expect(parseTranscriptTurn('')).toBeNull();
    expect(parseTranscriptTurn('null')).toBeNull();
  });

  test('non-conversational line types (system/summary) → null', () => {
    expect(parseTranscriptTurn(jl({ type: 'system', content: 'x' }))).toBeNull();
    expect(parseTranscriptTurn(jl({ type: 'summary', summary: 'x' }))).toBeNull();
  });

  test('ts is read from the line timestamp when present', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: 'hi' }], { timestamp: '2026-07-05T12:00:00Z' }));
    expect(turn.ts).toBe('2026-07-05T12:00:00Z');
  });

  test('ANSI escape sequences are stripped from turn text', () => {
    const dirty = ESC + '[31mred' + ESC + '[0m and ' + ESC + ']0;title' + String.fromCharCode(0x07) + 'done';
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: dirty }]));
    expect(turn.text).toBe('red and done');
    expect(turn.text.includes(ESC)).toBe(false);
  });

  test('a turn longer than 64KB is truncated with an ellipsis', () => {
    const huge = 'y'.repeat(70000);
    const turn = parseTranscriptTurn(asstLine([{ type: 'text', text: huge }]));
    expect(turn.text.length).toBe(65536);
    expect(turn.text.endsWith('…')).toBe(true);
  });
});

test.describe('lib/transcript.stripAnsi', () => {
  test('removes CSI, OSC, and lone escapes; leaves plain prose', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
    expect(stripAnsi(ESC + '[1;32mgreen' + ESC + '[0m')).toBe('green');
    expect(stripAnsi(ESC + ']8;;http://x' + String.fromCharCode(0x07) + 'link')).toBe('link');
    expect(stripAnsi(123)).toBe(''); // non-string → ''
  });
});

// ============================================================
// G5: cursor codec — opaque base64 of a byte offset
// ============================================================
test.describe('lib/transcript.cursor codec', () => {
  test('round-trips a byte offset', () => {
    for (const n of [0, 1, 42, 1024, 5_000_000]) {
      expect(decodeCursor(encodeCursor(n))).toBe(n);
    }
  });

  test('rejects non-string, empty, non-digit, and non-canonical inputs', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!not base64!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('foo').toString('base64'))).toBeNull();     // decodes to 'foo'
    expect(decodeCursor(Buffer.from('-5').toString('base64'))).toBeNull();      // negative
    expect(decodeCursor(Buffer.from('1.5').toString('base64'))).toBeNull();     // non-integer
    expect(decodeCursor(Buffer.from(' 12').toString('base64'))).toBeNull();     // whitespace → non-canonical
  });
});

// ============================================================
// G5: scanTurnsBackward — backward paginator over an injected chunk reader
// ============================================================
test.describe('lib/transcript.scanTurnsBackward', () => {
  // Build a JSONL "file" as a Buffer + a reader closure over it. Returns the
  // fixture plus how many lines are genuinely conversational (skips excluded).
  function buildFile(count) {
    const lines = [];
    let convo = 0;
    for (let i = 0; i < count; i++) {
      lines.push(userLine('q' + i)); convo++;
      if (i % 4 === 0) lines.push(userLine([{ type: 'tool_result', tool_use_id: 't', content: 'r' }])); // skipped
      const blocks = [{ type: 'text', text: 'a' + i }];
      if (i % 3 === 0) blocks.push({ type: 'tool_use', name: 'Bash', input: { command: 'c' + i } });
      lines.push(asstLine(blocks)); convo++;
    }
    lines.splice(3, 0, '{ malformed'); // one unparseable line, skipped
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    return { buf, fileSize: buf.length, convo, reader: (off, len) => buf.slice(off, off + len) };
  }

  test('no cursor → the LAST `limit` turns, newest-last, with a cursor + hasMore', () => {
    const { fileSize, reader } = buildFile(60); // 120 conversational turns
    const r = scanTurnsBackward(reader, fileSize, { limit: 50 });
    expect(r.turns.length).toBe(50);
    expect(r.hasMore).toBe(true);
    expect(r.cursor).not.toBeNull();
    // newest-last: final turn is the very last assistant line
    expect(r.turns[r.turns.length - 1]).toMatchObject({ role: 'assistant', text: 'a59' });
    // roles alternate sanely and none are skipped types
    expect(r.turns.every(t => t.role === 'user' || t.role === 'assistant')).toBe(true);
  });

  test('default limit is 50 when omitted', () => {
    const { fileSize, reader } = buildFile(60);
    expect(scanTurnsBackward(reader, fileSize, {}).turns.length).toBe(50);
  });

  test('limit is capped at 200', () => {
    const { fileSize, reader } = buildFile(150); // 300 turns
    const r = scanTurnsBackward(reader, fileSize, { limit: 9999 });
    expect(r.turns.length).toBe(200);
  });

  test('walking `before` cursors reaches the file start with hasMore=false', () => {
    const { fileSize, convo, reader } = buildFile(60);
    let before = null, all = [], pages = 0;
    for (;;) {
      const r = scanTurnsBackward(reader, fileSize, { before, limit: 50 });
      all = r.turns.concat(all); // prepend the older page
      pages++;
      if (!r.hasMore) { expect(r.cursor).toBeNull(); break; }
      before = decodeCursor(r.cursor);
      expect(before).not.toBeNull();
      expect(pages).toBeLessThan(20); // guard against a pagination loop
    }
    expect(all.length).toBe(convo);
    expect(all[0]).toMatchObject({ role: 'user', text: 'q0' });           // oldest
    expect(all[all.length - 1]).toMatchObject({ role: 'assistant', text: 'a59' }); // newest
  });

  test('malformed + tool_result-only lines are skipped (never appear as turns)', () => {
    const { fileSize, convo, reader } = buildFile(10);
    const r = scanTurnsBackward(reader, fileSize, { limit: 500 });
    expect(r.turns.length).toBe(convo);           // exactly the conversational lines
    expect(r.turns.some(t => t.text === undefined)).toBe(false);
    expect(r.turns.every(t => typeof t.text === 'string')).toBe(true);
  });

  test('a file with fewer turns than limit returns them all with hasMore=false', () => {
    const { fileSize, convo, reader } = buildFile(3); // 6 turns
    const r = scanTurnsBackward(reader, fileSize, { limit: 50 });
    expect(r.turns.length).toBe(convo);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  test('identical results regardless of chunk size (cross-boundary line reconstruction)', () => {
    const { fileSize, reader } = buildFile(40);
    const big = scanTurnsBackward(reader, fileSize, { limit: 200, chunkSize: 1 << 20 });
    for (const cs of [1, 3, 7, 64, 500]) {
      const small = scanTurnsBackward(reader, fileSize, { limit: 200, chunkSize: cs });
      expect(small.turns).toEqual(big.turns);
      expect(small.hasMore).toBe(big.hasMore);
    }
  });

  test('before=0 yields an empty page at the file start', () => {
    const { fileSize, reader } = buildFile(10);
    const r = scanTurnsBackward(reader, fileSize, { before: 0, limit: 50 });
    expect(r.turns).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  test('the returned cursor points at the oldest turn on the page (next page continues from there)', () => {
    const { fileSize, reader } = buildFile(60);
    const p1 = scanTurnsBackward(reader, fileSize, { limit: 20 });
    const oldestOnP1 = p1.turns[0];
    const p2 = scanTurnsBackward(reader, fileSize, { before: decodeCursor(p1.cursor), limit: 20 });
    // p2's newest turn is strictly older than p1's oldest — no overlap, no gap.
    expect(p2.turns[p2.turns.length - 1].text).not.toBe(oldestOnP1.text);
    // Concatenated, p2 then p1 are contiguous in the original order.
    const merged = p2.turns.concat(p1.turns).map(t => t.text);
    expect(new Set(merged).size).toBe(merged.length); // no duplicates
  });
});

// --- #19: pendingQuestion (structured AskUserQuestion from the transcript) ---
const askLine = (id, questions) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
});
const resultLine = (toolUseId) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'answered' }] },
});
const oneQ = [{ header: 'DB', question: 'Which database?', multiSelect: false,
  options: [{ label: 'Postgres', description: 'default' }, { label: 'MySQL', description: '' }] }];

test.describe('rich tool cards: extractToolResults + result pairing', () => {
  test('extractToolResults pulls tool_result text by tool_use_id', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'PASS 3 tests' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: [
          { type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' },
        ] },
      ] },
    });
    expect(extractToolResults(line)).toEqual([
      { id: 'tu_1', text: 'PASS 3 tests' },
      { id: 'tu_2', text: 'line one\n[image]\nline two' },
    ]);
  });

  test('a tool_result text is capped at 4000 chars', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(9000) },
      ] },
    });
    const [r] = extractToolResults(line);
    expect(r.text.length).toBe(4000);
    expect(r.text.endsWith('…')).toBe(true);
  });

  test('scanTurnsBackward attaches each tool output to its tool_use by id', () => {
    // Order in file: assistant calls the tool (older), then its result (newer).
    const { read, size } = memReader([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'tu_7', name: 'Bash', input: { command: 'npm test' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_7', content: 'PASS — 3 passed' },
      ] } },
    ]);
    const page = scanTurnsBackward(read, size, { limit: 10 });
    const tool = page.turns.flatMap((t) => t.toolUses).find((tu) => tu.id === 'tu_7');
    expect(tool.name).toBe('Bash');
    expect(tool.result).toBe('PASS — 3 passed');
  });

  test('a tool_use with no result gets no `result` field', () => {
    const { read, size } = memReader([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_x', name: 'Read', input: { file_path: 'a.js' } },
      ] } },
    ]);
    const page = scanTurnsBackward(read, size, { limit: 10 });
    const tool = page.turns.flatMap((t) => t.toolUses)[0];
    expect(tool.id).toBe('tu_x');
    expect(tool.result).toBeUndefined();
  });
});

test.describe('shapeQuestions (live PreToolUse hook input)', () => {
  test('shapes a raw AskUserQuestion tool_input into the app-facing list', () => {
    const shaped = shapeQuestions({ questions: oneQ });
    expect(shaped).toHaveLength(1);
    expect(shaped[0].header).toBe('DB');
    expect(shaped[0].multiSelect).toBe(false);
    expect(shaped[0].options.map((o) => o.label)).toEqual(['Postgres', 'MySQL']);
  });

  test('drops options with no label and returns [] for junk', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'H', question: 'Q', options: [{ label: '' }, { label: 'Keep' }] }],
    });
    expect(shaped[0].options.map((o) => o.label)).toEqual(['Keep']);
    expect(shapeQuestions(null)).toEqual([]);
    expect(shapeQuestions({ questions: 'nope' })).toEqual([]);
  });

  // The layout a question renders in decides what its keys MEAN, and only the
  // raw tool_input knows it. Dropping `preview` on the way to the client left
  // the app unable to tell the two apart, which is how a previewed question got
  // answered with a key sequence that never committed it.
  test('publishes hasPreview so the client can tell the two layouts apart', () => {
    const shaped = shapeQuestions({
      questions: [
        { header: 'A', question: 'previewed', options: [
          { label: 'One', preview: 'a mockup' }, { label: 'Two' },
        ] },
        { header: 'B', question: 'plain', options: [{ label: 'X' }, { label: 'Y' }] },
      ],
    });
    expect(shaped[0].hasPreview).toBe(true);
    expect(shaped[1].hasPreview).toBe(false);
    // Layout is per-QUESTION: a previewed question next to a plain one does not
    // drag the plain one side-by-side (measured against claude 2.1.220).
    expect(shaped.map((q) => q.hasPreview)).toEqual([true, false]);
  });

  test('hasPreview ignores empty/whitespace/non-string previews', () => {
    const shaped = shapeQuestions({
      questions: [
        { header: 'A', question: 'q', options: [{ label: 'One', preview: '   ' }] },
        { header: 'B', question: 'q', options: [{ label: 'One', preview: '' }] },
        { header: 'C', question: 'q', options: [{ label: 'One', preview: { not: 'a string' } }] },
      ],
    });
    expect(shaped.map((q) => q.hasPreview)).toEqual([false, false, false]);
  });

  // #145. This test used to assert the OPPOSITE — that the body never reaches
  // the client — which was right while nothing rendered it and wrong the moment
  // the overlay did. The side-by-side layout is exactly the one where the
  // preview carries the decision: a report on 2026-08-19 showed three terse
  // labels ("Land #182", "Play closed track upload", "Leave it") whose entire
  // technical content lived in the preview box, so the chat lens was strictly
  // less informative than the terminal.
  test('forwards the preview BODY so the overlay can render it', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [
        { label: 'One', preview: 'debug { applicationIdSuffix = ".debug" }' },
        { label: 'Two' },
      ] }],
    });
    expect(shaped[0].options[0].preview).toBe('debug { applicationIdSuffix = ".debug" }');
    // An option with no preview carries no empty string to render around.
    expect(shaped[0].options[1].preview).toBeUndefined();
  });

  test('a preview keeps its newlines — it is a block, not a line', () => {
    const body = 'net.hilash.rega\nnet.hilash.rega.debug\n\n  indented';
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [{ label: 'One', preview: body }] }],
    });
    expect(shaped[0].options[0].preview).toBe(body);
  });

  test('a preview is capped on its OWN budget, not the 800-char string cap', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [
        { label: 'One', description: 'd'.repeat(5000), preview: 'p'.repeat(5000) },
      ] }],
    });
    const opt = shaped[0].options[0];
    expect(opt.description).toHaveLength(800);          // PQ_STR_CAP
    expect(opt.preview).toHaveLength(PQ_PREVIEW_CAP);   // its own, larger budget
    expect(PQ_PREVIEW_CAP).toBeGreaterThan(800);
    expect(opt.preview.endsWith('…')).toBe(true);
  });

  test('ANSI in a preview is stripped like every other published string', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [
        { label: 'One', preview: ESC + '[31mred' + ESC + '[0m plain' },
      ] }],
    });
    expect(shaped[0].options[0].preview).toBe('red plain');
  });

  test('an empty/whitespace/non-string preview publishes NO preview field', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [
        { label: 'One', preview: '   ' },
        { label: 'Two', preview: '' },
        { label: 'Three', preview: { not: 'a string' } },
        { label: 'Four' },
      ] }],
    });
    expect(shaped[0].options.map((o) => o.preview)).toEqual([
      undefined, undefined, undefined, undefined,
    ]);
  });

  // The trap #145 was filed with: if `hasPreview` were ever recomputed from the
  // SHAPED options it would follow the cap and the label filter, and a question
  // whose preview was dropped would silently flip to the compact layout — which
  // decides what every answer key MEANS (#19/#84/#143). It must stay derived
  // from the raw input. Here the previewed option has no label and is dropped
  // from `options`, and the question must STILL report side-by-side.
  test('hasPreview is derived from the RAW input, before options are dropped', () => {
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options: [
        { label: '', preview: 'a mockup' },
        { label: 'Two' },
      ] }],
    });
    expect(shaped[0].options.map((o) => o.label)).toEqual(['Two']);
    expect(shaped[0].hasPreview).toBe(true);
  });

  // The SECOND of the three ways the shaped list loses a preview, and the one
  // the code actually got wrong (#143): the flag was read off the already-sliced
  // list, so a preview carried only by an option past PQ_MAX_OPTIONS reported
  // compact. Claude lays the selector out from ALL of its options, so that
  // question renders side-by-side and every answer key means something else —
  // a digit navigates instead of selecting, `n` opens a note editor, and the
  // "Type something." row the compact layout has does not exist at all.
  test('hasPreview is derived BEFORE the PQ_MAX_OPTIONS slice', () => {
    const options = [];
    for (let i = 0; i < PQ_MAX_OPTIONS; i++) options.push({ label: 'Opt' + i });
    options.push({ label: 'Past the cap', preview: 'a mockup' });
    const shaped = shapeQuestions({
      questions: [{ header: 'A', question: 'q', options }],
    });
    // The option itself is correctly dropped — only the FLAG must survive it.
    expect(shaped[0].options).toHaveLength(PQ_MAX_OPTIONS);
    expect(shaped[0].options.some((o) => o.label === 'Past the cap')).toBe(false);
    expect(shaped[0].hasPreview).toBe(true);
  });
});

test.describe('pendingQuestion', () => {
  test('returns null for empty / non-question transcript', () => {
    expect(pendingQuestion('')).toBeNull();
    expect(pendingQuestion(JSON.stringify(asst('just talking')))).toBeNull();
  });

  test('parses a pending single-question prompt', () => {
    const q = pendingQuestion(askLine('toolu_1', oneQ));
    expect(q).not.toBeNull();
    expect(q.toolUseId).toBe('toolu_1');
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].header).toBe('DB');
    expect(q.questions[0].multiSelect).toBe(false);
    expect(q.questions[0].options.map(o => o.label)).toEqual(['Postgres', 'MySQL']);
  });

  test('parses a multi-question (tabbed) prompt', () => {
    const twoQ = [
      { header: 'Lang', question: 'Language?', options: [{ label: 'Dart' }, { label: 'Go' }] },
      { header: 'CI', question: 'CI?', multiSelect: true, options: [{ label: 'GH Actions' }, { label: 'None' }] },
    ];
    const q = pendingQuestion(askLine('toolu_x', twoQ));
    expect(q.questions).toHaveLength(2);
    expect(q.questions[1].multiSelect).toBe(true);
    expect(q.questions[1].options.map(o => o.label)).toEqual(['GH Actions', 'None']);
  });

  test('an answered question (matching tool_result) is not pending', () => {
    const text = [askLine('toolu_1', oneQ), resultLine('toolu_1')].join('\n');
    expect(pendingQuestion(text)).toBeNull();
  });

  test('returns the newest pending when an older one was answered', () => {
    const text = [
      askLine('toolu_old', oneQ),
      resultLine('toolu_old'),
      askLine('toolu_new', [{ header: 'X', question: 'Pick', options: [{ label: 'A' }] }]),
    ].join('\n');
    const q = pendingQuestion(text);
    expect(q.toolUseId).toBe('toolu_new');
    expect(q.questions[0].options[0].label).toBe('A');
  });

  test('drops options with no label and caps/sanitizes strings', () => {
    const dirty = [{ header: 'H', question: 'Q', options: [
      { label: '', description: 'no label -> dropped' },
      { label: 'Keep', description: 'x'.repeat(2000) },
    ] }];
    const q = pendingQuestion(askLine('toolu_d', dirty));
    expect(q.questions[0].options).toHaveLength(1);
    expect(q.questions[0].options[0].label).toBe('Keep');
    expect(q.questions[0].options[0].description.length).toBeLessThanOrEqual(800);
  });

  test('a question with no valid options yields no pending question', () => {
    const empty = [{ header: 'H', question: 'Q', options: [{ description: 'x' }] }];
    expect(pendingQuestion(askLine('toolu_e', empty))).toBeNull();
  });
});

// --- subagent trace (chat-mode parity with the terminal subagent panel) -------
// The pure half of the feature: parse the agent-*.meta.json sidecar, find which
// tools have finished (resolved ids), and stamp a { agentType, description,
// running } stub onto each Task tool_use. server.js supplies the file I/O; these
// three functions carry the linkage + running logic and are exhaustively testable.
test.describe('lib/transcript.parseAgentMeta', () => {
  test('parses a well-formed meta sidecar', () => {
    const m = parseAgentMeta(JSON.stringify({
      agentType: 'Explore', description: 'Find chat mode',
      toolUseId: 'toolu_01ABC', parentAgentId: 'x', spawnDepth: 1,
    }));
    expect(m).toEqual({ agentType: 'Explore', description: 'Find chat mode', toolUseId: 'toolu_01ABC' });
  });
  test('null on malformed JSON', () => {
    expect(parseAgentMeta('{ not json')).toBeNull();
    expect(parseAgentMeta('')).toBeNull();
    expect(parseAgentMeta('[]')).toBeNull(); // array is not a usable object shape here
  });
  test('null when there is no toolUseId to link a Task to', () => {
    expect(parseAgentMeta(JSON.stringify({ agentType: 'X', description: 'd' }))).toBeNull();
    expect(parseAgentMeta(JSON.stringify({ toolUseId: 123 }))).toBeNull(); // non-string id
  });
  test('caps long labels and strips ANSI', () => {
    const m = parseAgentMeta(JSON.stringify({
      toolUseId: 't', agentType: 'A', description: '\x1b[31m' + 'z'.repeat(1000),
    }));
    expect(m.description.length).toBeLessThanOrEqual(400);
    expect(m.description).not.toContain('\x1b');
  });
});

test.describe('lib/transcript.collectResolvedIds', () => {
  test('returns the set of tool_use_ids that have a tool_result', () => {
    const lines = [
      JSON.stringify(asst('start')),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' },
      ] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'done' }] },
      ] } }),
    ].join('\n');
    const set = collectResolvedIds(lines);
    expect(set.has('toolu_a')).toBe(true);
    expect(set.has('toolu_b')).toBe(true);
    expect(set.has('toolu_missing')).toBe(false);
  });
  test('empty / non-string input -> empty set (never throws)', () => {
    expect(collectResolvedIds('').size).toBe(0);
    expect(collectResolvedIds(null).size).toBe(0);
  });
});

test.describe('lib/transcript.attachSubagentStubs', () => {
  const taskTurn = (id, result) => ({
    role: 'assistant', text: '', ts: null,
    toolUses: [{ name: 'Task', id, inputPreview: '', input: { description: 'd' }, ...(result != null ? { result } : {}) }],
  });
  const meta = { agentType: 'Explore', description: 'Find chat mode' };

  test('stamps a stub on a Task with a known subagent; running when unresolved', () => {
    const turns = [taskTurn('toolu_x')];
    attachSubagentStubs(turns, (id) => (id === 'toolu_x' ? meta : null), () => false);
    expect(turns[0].toolUses[0].subagent).toEqual({
      agentType: 'Explore', description: 'Find chat mode', running: true,
    });
  });
  test('running=false when the Task has an in-page result', () => {
    const turns = [taskTurn('toolu_x', 'final report')];
    attachSubagentStubs(turns, () => meta, () => false);
    expect(turns[0].toolUses[0].subagent.running).toBe(false);
  });
  test('running=false when the Task id is in the resolved set (finished off-page)', () => {
    const turns = [taskTurn('toolu_x')];
    attachSubagentStubs(turns, () => meta, (id) => id === 'toolu_x');
    expect(turns[0].toolUses[0].subagent.running).toBe(false);
  });
  test('no stub when the tool_use id has no matching subagent meta', () => {
    const turns = [taskTurn('toolu_x')];
    attachSubagentStubs(turns, () => null, () => false);
    expect(turns[0].toolUses[0].subagent).toBeUndefined();
  });
  test('a tool_use with no id is never stamped', () => {
    const turns = [{ role: 'assistant', text: '', ts: null, toolUses: [
      { name: 'Task', id: '', inputPreview: '', input: {} },
    ] }];
    attachSubagentStubs(turns, () => meta, () => false);
    expect(turns[0].toolUses[0].subagent).toBeUndefined();
  });
  // The link is the meta toolUseId, not the tool NAME — the CLI names the spawner
  // `Task` but other hosts name it `Agent`. Both must be stamped when linked.
  test('an Agent-named tool_use IS stamped when its id resolves to a subagent', () => {
    const turns = [{ role: 'assistant', text: '', ts: null, toolUses: [
      { name: 'Agent', id: 'toolu_agent', inputPreview: '', input: {} },
    ] }];
    attachSubagentStubs(turns, (id) => (id === 'toolu_agent' ? meta : null), () => false);
    expect(turns[0].toolUses[0].subagent).toEqual({
      agentType: 'Explore', description: 'Find chat mode', running: true,
    });
  });
});
