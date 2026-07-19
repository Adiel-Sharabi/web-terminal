// The pure rule behind #70 read-aloud: what survives from an assistant turn to
// become a spoken utterance.
//
// The feature's value is entirely in what it REFUSES to say. Reading a Claude
// turn verbatim means reading diffs, markdown table pipes and URLs aloud — the
// naive design that gets a voice feature switched off on day one. Every removal
// below is a rule with a test, so a future edit that "simplifies" the filter
// fails here rather than in the user's ears.
const { test, expect } = require('@playwright/test');
const { toSpeech, speechFromTurns, extractSummary, DEFAULT_MAX_SENTENCES } = require('../lib/speech');

test.describe('the summary ladder', () => {
  test('speaks a trailing TL;DR section instead of the opening sentences', () => {
    // The whole point: first-N-sentences is a LENGTH rule, not an importance
    // rule, so a conclusion in the last paragraph was never heard.
    const turn = [
      'I looked at three options and rejected two of them.',
      'The first was too slow. The second broke the Windows build.',
      '',
      '## TL;DR',
      'Went with the third option. It needs no new dependency.',
    ].join('\n');
    expect(toSpeech(turn)).toBe('Went with the third option. It needs no new dependency.');
  });

  test('matches Summary, Bottom line and the inline "**TL;DR:** x" form', () => {
    expect(toSpeech('Long preamble here.\n\n### Summary\nIt works now.')).toBe('It works now.');
    expect(toSpeech('Blah blah.\n\n**Bottom line**\nShip it.')).toBe('Ship it.');
    expect(toSpeech('Blah blah.\n\n**TL;DR:** All three servers are green.'))
      .toBe('All three servers are green.');
  });

  test('takes the LAST summary when a turn somehow has two', () => {
    const turn = '## Summary\nold one.\n\n## Details\nstuff.\n\n## Summary\nthe real one.';
    expect(toSpeech(turn)).toBe('the real one.');
  });

  test('a summary section stops at the next heading', () => {
    const turn = '## TL;DR\nThe short answer.\n\n## Appendix\nDo not read this.';
    expect(toSpeech(turn)).toBe('The short answer.');
  });

  test('falls back to first-N-sentences when there is no summary', () => {
    expect(extractSummary('Just an ordinary answer. With two sentences.')).toBeNull();
    expect(toSpeech('Just an ordinary answer. With two sentences.'))
      .toBe('Just an ordinary answer. With two sentences.');
  });

  test('preferSummary:false disables the ladder', () => {
    // With the ladder off the whole turn is spoken, heading text and all — which
    // is exactly why the ladder exists.
    const turn = 'Opening line.\n\n## TL;DR\nThe summary.';
    expect(toSpeech(turn, { preferSummary: false })).toBe('Opening line. TL;DR The summary.');
  });
});

test.describe('speaking identifiers like a person', () => {
  test('a path is reduced to its basename without the extension', () => {
    expect(toSpeech('The fix is in lib/agents.js today.'))
      .toBe('The fix is in agents today.');
  });

  test('a hyphenated filename becomes words', () => {
    // "pty-worker.js" read literally is "P T Y hyphen worker dot J S".
    expect(toSpeech('Restart pty-worker.js now.')).toBe('Restart pty worker now.');
  });

  test('camelCase is split so each word is pronounced', () => {
    expect(toSpeech('Call buildComposeSubmission first.'))
      .toBe('Call build Compose Submission first.');
  });

  test('ordinary prose is left alone', () => {
    // The gates must not fire on normal English.
    expect(toSpeech('The server is up and the tests all pass.'))
      .toBe('The server is up and the tests all pass.');
    expect(toSpeech('It cost 3.5 hours.')).toBe('It cost 3.5 hours.');
  });
});

test.describe('toSpeech — block removals', () => {
  test('drops a fenced code block entirely, keeping the prose around it', () => {
    const s = toSpeech('Here is the fix:\n```js\nconst x = 1;\nfoo(x);\n```\nThat resolves it.');
    expect(s).toBe('Here is the fix: That resolves it.');
  });

  test('drops a tilde-fenced block too', () => {
    const s = toSpeech('Before.\n~~~\nraw stuff\n~~~\nAfter.');
    expect(s).toBe('Before. After.');
  });

  test('drops an UNTERMINATED fence through end of input', () => {
    // A turn cut off by the transcript cap leaves a dangling fence; without the
    // `$` alternative the whole tail would be spoken as code.
    const s = toSpeech('Result below.\n```\nline one\nline two');
    expect(s).toBe('Result below.');
  });

  test('drops a markdown table, header separator and all', () => {
    const md = 'Summary.\n\n| col | val |\n|-----|-----|\n| a   | 1   |\n\nDone.';
    expect(toSpeech(md)).toBe('Summary. Done.');
  });

  test('drops a horizontal rule but not a list item that starts with a dash', () => {
    expect(toSpeech('One.\n\n---\n\nTwo.')).toBe('One. Two.');
    expect(toSpeech('- first thing')).toBe('first thing');
  });
});

test.describe('toSpeech — inline rewrites', () => {
  test('keeps a link label and drops its URL', () => {
    expect(toSpeech('See [the docs](https://example.com/x) for more.'))
      .toBe('See the docs for more.');
  });

  test('drops a bare URL', () => {
    expect(toSpeech('Fetched https://example.com/a/b ok.')).toBe('Fetched ok.');
  });

  test('drops an image entirely, alt text included', () => {
    expect(toSpeech('Chart: ![a graph](x.png) done.')).toBe('Chart: done.');
  });

  test('keeps inline-code CONTENT but not its backticks', () => {
    // Dropping the span would gut the sentence: "the fix is in at line 42".
    // The content is then shaped for the ear (see "speaking identifiers"), so
    // the path arrives as its basename rather than "lib slash agents dot J S".
    expect(toSpeech('The fix is in `lib/agents.js` at line 42.'))
      .toBe('The fix is in agents at line 42.');
  });

  test('an underscore becomes a space, so an identifier is not fused', () => {
    expect(toSpeech('Call some_var now.')).toBe('Call some var now.');
  });

  test('strips heading, blockquote, bullet and ordered-list markers', () => {
    expect(toSpeech('## Result')).toBe('Result');
    expect(toSpeech('> quoted claim')).toBe('quoted claim');
    expect(toSpeech('* bullet text')).toBe('bullet text');
    expect(toSpeech('1. numbered text')).toBe('numbered text');
    expect(toSpeech('- [x] checked item')).toBe('checked item');
  });

  test('strips emoji rather than letting a synthesiser name them aloud', () => {
    expect(toSpeech('Done ✅ shipped \u{1F680}')).toBe('Done shipped');
  });

  test('strips ANSI control sequences', () => {
    const ESC = String.fromCharCode(0x1b);
    expect(toSpeech(ESC + '[31mred text' + ESC + '[0m')).toBe('red text');
  });

  test('collapses all whitespace to single spaces', () => {
    expect(toSpeech('a\n\n\nb   c\td')).toBe('a b c d');
  });
});

test.describe('toSpeech — length bounds', () => {
  test('stops at the sentence cap', () => {
    const src = 'One. Two. Three. Four. Five. Six.';
    expect(toSpeech(src)).toBe('One. Two. Three. Four.');
    expect(DEFAULT_MAX_SENTENCES).toBe(4);
  });

  test('honours an explicit lower sentence cap', () => {
    expect(toSpeech('One. Two. Three.', { maxSentences: 2 })).toBe('One. Two.');
  });

  test('stops adding sentences once the char budget is spent', () => {
    const s = toSpeech('AAAA. BBBB. CCCC.', { maxChars: 11 });
    expect(s).toBe('AAAA. BBBB.');
  });

  test('always yields at least one sentence, hard-truncated if it alone is too long', () => {
    // A single run-on line has no terminator to split on — the char cap is the
    // only backstop, and returning '' here would silently say nothing.
    const s = toSpeech('x'.repeat(50), { maxChars: 20 });
    expect(s.length).toBe(21); // 20 chars + the ellipsis
    expect(s.endsWith('…')).toBe(true);
  });
});

test.describe('toSpeech — nothing to say', () => {
  test('empty, non-string and whitespace-only inputs yield an empty string', () => {
    expect(toSpeech('')).toBe('');
    expect(toSpeech(null)).toBe('');
    expect(toSpeech(undefined)).toBe('');
    expect(toSpeech(42)).toBe('');
    expect(toSpeech('   \n\t ')).toBe('');
  });

  test('a turn that is ONLY a code block yields nothing rather than reading code', () => {
    expect(toSpeech('```\nnpm install\n```')).toBe('');
  });

  test('a turn that is only a table yields nothing', () => {
    expect(toSpeech('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('');
  });
});

test.describe('speechFromTurns', () => {
  const turn = (role, text, extra = {}) => ({ role, text, toolUses: [], ts: null, ...extra });

  test('picks the NEWEST assistant prose turn (turns arrive newest-last)', () => {
    const turns = [turn('assistant', 'Older answer.'), turn('user', 'q'), turn('assistant', 'Newer answer.')];
    expect(speechFromTurns(turns).text).toBe('Newer answer.');
  });

  test('skips a tool-use-only assistant turn and speaks the prose before it', () => {
    // This is the whole point: the newest turn is often a bare tool call.
    const turns = [
      turn('assistant', 'The real answer.'),
      turn('assistant', '', { toolUses: [{ name: 'Bash', inputPreview: '{}' }] }),
    ];
    expect(speechFromTurns(turns).text).toBe('The real answer.');
  });

  test('never speaks a user turn', () => {
    expect(speechFromTurns([turn('user', 'my own prompt')]).text).toBe('');
  });

  test('carries the turn timestamp through', () => {
    const turns = [turn('assistant', 'Hi.', { ts: '2026-07-19T10:00:00Z' })];
    expect(speechFromTurns(turns).ts).toBe('2026-07-19T10:00:00Z');
  });

  test('empty / malformed pages yield nothing, never throw', () => {
    expect(speechFromTurns([]).text).toBe('');
    expect(speechFromTurns(null).text).toBe('');
    expect(speechFromTurns([null, undefined]).text).toBe('');
  });

  test('an assistant turn whose prose is ALL code yields nothing, not a fallback', () => {
    // Falling back to raw text here would defeat the filter entirely.
    const turns = [turn('assistant', '```\nrm -rf /\n```')];
    expect(speechFromTurns(turns).text).toBe('');
  });
});
