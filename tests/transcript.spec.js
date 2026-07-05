// @ts-check
// lib/transcript.js — pulls Claude's last assistant message out of a Claude Code
// transcript JSONL so a phone push can quote what Claude actually said/asked.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastAssistantText } = require('../lib/transcript');

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
