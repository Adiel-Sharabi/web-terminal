// @ts-check
// #383 - server text caps that cut an inbox question. Each rule here fails without its change.
const { test, expect } = require('@playwright/test');
const { clipAtWord } = require('../lib/clip-text');
const { shapeQuestions, PQ_QUESTION_CAP } = require('../lib/transcript');
const { parseBackgroundListing } = require('../lib/background-listing');
const B = require('../lib/session-brief');
const { rawSummaryFromTurns, speechFromTurns } = require('../lib/speech');

test.describe('clipAtWord', () => {
  test('returns a string that fits unchanged', () => {
    expect(clipAtWord('short one', 20)).toBe('short one');
  });
  test('cuts at a word, adds an ellipsis, stays within max', () => {
    const out = clipAtWord('alpha beta gamma delta epsilon', 18);
    expect(out).toBe('alpha beta gamma…');
    expect(out.length).toBeLessThanOrEqual(18);
  });
  test('one long token is cut hard, never emptied', () => {
    const out = clipAtWord('x'.repeat(100), 10);
    expect(out).toBe('x'.repeat(9) + '…');
  });
  test('never splits a surrogate pair', () => {
    const out = clipAtWord('a'.repeat(8) + '😀😀😀', 10);
    expect(out).not.toMatch(/[\ud800-\udbff]…$/);
  });
});

test('a 1221-char question survives whole', () => {
  const q = ('Which of these approaches should we take for the migration? ').repeat(20).slice(0, 1221);
  const shaped = shapeQuestions({ questions: [{ header: 'H', question: q, options: [{ label: 'A' }, { label: 'B' }] }] });
  expect(shaped[0].question).toBe(q);
  expect(PQ_QUESTION_CAP).toBeGreaterThanOrEqual(1221);
});

test('a question over the cap is cut at a word with an ellipsis', () => {
  // 11-char period: a naive slice at PQ_QUESTION_CAP-1 lands 6 letters into a word.
  const q = 'abcdefghij '.repeat(500);
  expect(q.slice(0, PQ_QUESTION_CAP - 1).endsWith('abcdef')).toBe(true); // fixture check
  const shaped = shapeQuestions({ questions: [{ header: 'H', question: q, options: [{ label: 'A' }] }] });
  const out = shaped[0].question;
  expect(out.length).toBeLessThanOrEqual(PQ_QUESTION_CAP);
  expect(out.endsWith('abcdefghij…')).toBe(true);
});

test('hasPreview still comes from the RAW options, and descriptions keep the 800 cap', () => {
  const shaped = shapeQuestions({ questions: [{ header: 'H', question: 'q', options: [
    { label: 'A', description: 'd'.repeat(5000), preview: 'p' }, { label: 'B' }] }] });
  expect(shaped[0].hasPreview).toBe(true);
  expect(shaped[0].options[0].description).toHaveLength(800);
});

test('background waitingFor is cut at a word with an ellipsis', () => {
  // 11-char period: a naive cut at 400 lands mid-word.
  const text = 'abcdefghij '.repeat(60).trim();
  expect(text.slice(0, 399).endsWith('abc')).toBe(true); // fixture check
  const rows = parseBackgroundListing(JSON.stringify([
    { kind: 'background', id: 'deadbeef', state: 'blocked', status: 'waiting', waitingFor: text }]));
  const w = rows[0].waitingFor;
  expect(w.length).toBeLessThanOrEqual(400);
  expect(w.endsWith('…')).toBe(true);
  expect(w.endsWith('abcdefghij…')).toBe(true);
  // 300 chars is a real sentence length and must come back whole (fails at the old 200).
  const mid = 'abcdefghi '.repeat(30).trim();
  const kept = parseBackgroundListing(JSON.stringify([{ kind: 'background', id: 'deadbeef', waitingFor: mid }]));
  expect(kept[0].waitingFor).toBe(mid);
  const short = parseBackgroundListing(JSON.stringify([{ kind: 'background', id: 'deadbeef', waitingFor: 'dialog open' }]));
  expect(short[0].waitingFor).toBe('dialog open');
});

test('wait.what is cut at a word with an ellipsis', () => {
  const what = 'reconnect the test rig and then restart the whole controller bank before the next run starts please';
  const r = B.validateReport({ wait: { on: 'you', what } }, B.applyReport(B.emptyEntry(), { headline: 'h' }, 1));
  const out = r.report.wait.what;
  expect(out.length).toBeLessThanOrEqual(B.LIMITS.wait);
  expect(out.endsWith('…')).toBe(true);
  expect(what.startsWith(out.slice(0, -1))).toBe(true);
  expect(what[out.length - 1]).toBe(' ');
});

test('did keeps identifiers from a raw TL;DR; the speech form does not', () => {
  const text = 'Long analysis.\n\n## TL;DR\nFixed `snake_case_name` in foo-bar.js; please choose option A.';
  const turns = [{ role: 'assistant', text, ts: 't' }];
  const raw = rawSummaryFromTurns(turns).text;
  expect(raw).toContain('snake_case_name');
  expect(raw).toContain('foo-bar');
  expect(raw).toContain('`');
  expect(speechFromTurns(turns).text).not.toContain('snake_case_name');
  const did = B.clipWords(raw, B.LIMITS.did);
  expect(did).toBe(raw);
});

test('raw did: without a TL;DR, fenced code is dropped, tool-only turns skipped, long text cut at a word', () => {
  const turns = [
    { role: 'assistant', text: 'Here is the plan for my_module.\n```js\nconst x = 1;\n```\nThen run it.', ts: 'a' },
    { role: 'assistant', text: '', ts: 'b' },
  ];
  expect(rawSummaryFromTurns(turns).text).toBe('Here is the plan for my_module. Then run it.');
  const did = B.clipWords('abcdefghij '.repeat(100), B.LIMITS.did);
  expect(did.length).toBeLessThanOrEqual(B.LIMITS.did);
  expect(did.endsWith('abcdefghij…')).toBe(true);
});

test('a ~500-char did with a TL;DR comes back whole (fails at the old 280 cap)', () => {
  const tldr = 'Fixed the_thing in foo-bar. ' + 'abcdefghi '.repeat(46).trim();
  expect(tldr.length).toBeGreaterThan(480);
  const turns = [{ role: 'assistant', text: 'Long body.\n\n## TL;DR\n' + tldr, ts: 't' }];
  const did = B.clipWords(rawSummaryFromTurns(turns).text, B.LIMITS.did);
  expect(did).toBe(tldr);
});

test.describe('did is ONE plain line, stripped at block level', () => {
  const noBlockMarkup = (t) => {
    expect(t).not.toMatch(/^#/);
    expect(t).not.toContain('|');
    expect(t).not.toContain('```');
    expect(t).not.toContain('~~~');
    expect(t).not.toContain('\n');
  };
  const did = (text) => rawSummaryFromTurns([{ role: 'assistant', text }]).text;
  test('headings, bullets and a table', () => {
    const t = did('## Findings\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    noBlockMarkup(t);
    expect(t).toBe('Findings a b');
  });
  test('bullets with bold, identifiers survive', () => {
    const t = did('- merged the fix\n- please pick **A** for `snake_case_name`');
    noBlockMarkup(t);
    expect(t).toBe('merged the fix please pick **A** for `snake_case_name`');
  });
  test('a ~~~ fence, an hr and numbered items', () => {
    const t = did('1. first\n---\n~~~\ncode | x\n~~~\n2) second');
    noBlockMarkup(t);
    expect(t).toBe('first second');
  });
});

test('server.js feeds the brief "did" from the RAW summary and keeps it off /speech (source gate)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function refreshBriefDid'), src.indexOf('function dashboardHookAnswer'));
  expect(fn).toContain('const { raw } = speechFromTranscriptPath');
  expect(fn).toContain('briefLib.clipWords(raw');
  expect(src).toContain('res.json({ text, ts, agent });');
});
