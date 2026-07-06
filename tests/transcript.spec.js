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
  pendingQuestion, shapeQuestions,
} = require('../lib/transcript');

// Write lines (objects) as JSONL to a unique temp file; returns the path.
let _n = 0;
function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `wt_transcript_${process.pid}_${++_n}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}
const asst = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const user = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

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
    expect(turn.toolUses).toEqual([{ name: 'Bash', inputPreview: '{"command":"npm test"}' }]);
  });

  test('assistant tool_use-ONLY turn is KEPT (text empty, toolUses populated)', () => {
    const turn = parseTranscriptTurn(asstLine([{ type: 'tool_use', name: 'Read', input: { file: 'a.js' } }]));
    expect(turn.role).toBe('assistant');
    expect(turn.text).toBe('');
    expect(turn.toolUses).toEqual([{ name: 'Read', inputPreview: '{"file":"a.js"}' }]);
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
    expect(parseTranscriptTurn(userLine('do the thing'))).toEqual({ role: 'user', text: 'do the thing', toolUses: [], ts: null });
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
