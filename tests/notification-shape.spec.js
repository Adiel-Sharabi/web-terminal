// @ts-check
// lib/notification-shape.js — what a Claude `Notification` hook event IS, and
// what is safe to write about one into a log.
//
// #194 Gap 1: an unrecognised notification was discarded in silence, so the set
// of messages Claude actually sends was unknowable from this fleet's logs —
// `notification-other` never reached a logger and raw hook bodies are never
// logged. Verified 2026-08-31: zero hits across every file in `logs/`.
//
// This spec's job is to pin the CLASSIFICATION as unchanged while the reporting
// changes. Flipping the fallthrough to `permission` is the tempting fix and it
// is not safe on current evidence — `correctStaleStatus` gives a `waiting`
// session 12 hours against 5 minutes for a `working` one, so a benign message
// misread as an approval ask parks a session on a false "waiting" for half a
// day. Measure, then decide.
const { test, expect } = require('@playwright/test');
const {
  NOTIFICATION_KINDS,
  NOTIFICATION_MSG_CAP,
  NOTIFICATION_MATCHER_CAP,
  matcherOf,
  classifyNotification,
  redactNotificationMessage,
  redactMatcher,
  noteShape,
  newDropState,
  noteDrop,
  shouldLogDrop,
} = require('../lib/notification-shape');

test.describe('classifyNotification — behaviour is UNCHANGED', () => {
  test('an explicit permission matcher is a permission ask', () => {
    expect(classifyNotification({ notification_type: 'permission_prompt' }))
      .toBe(NOTIFICATION_KINDS.PERMISSION);
  });

  test('older versions carry the same fact in the prose', () => {
    // The exact fixture tests/api.spec.js drives over HTTP.
    expect(classifyNotification({ message: 'Claude needs your permission to run a command' }))
      .toBe(NOTIFICATION_KINDS.PERMISSION);
    expect(classifyNotification({ message: 'Waiting for approval' }))
      .toBe(NOTIFICATION_KINDS.PERMISSION);
  });

  test('idle is idle, by matcher or by prose', () => {
    expect(classifyNotification({ notification_type: 'idle_prompt' }))
      .toBe(NOTIFICATION_KINDS.IDLE);
    expect(classifyNotification({ message: 'Claude is waiting for your input' }))
      .toBe(NOTIFICATION_KINDS.IDLE);
  });

  test('the two known-harmless matchers are BENIGN, not unknown', () => {
    // The split is the whole point of the change: logging these would bury the
    // signal under noise that is already understood.
    for (const m of ['auth_success', 'elicitation_dialog']) {
      expect(classifyNotification({ notification_type: m })).toBe(NOTIFICATION_KINDS.BENIGN);
    }
  });

  test('anything else is UNKNOWN — the case that used to vanish', () => {
    expect(classifyNotification({ notification_type: 'something_new' }))
      .toBe(NOTIFICATION_KINDS.UNKNOWN);
    expect(classifyNotification({ message: 'Claude has finished rearranging the furniture' }))
      .toBe(NOTIFICATION_KINDS.UNKNOWN);
    expect(classifyNotification({})).toBe(NOTIFICATION_KINDS.UNKNOWN);
    expect(classifyNotification(null)).toBe(NOTIFICATION_KINDS.UNKNOWN);
  });

  test('the matcher FIELD LIST has one owner', () => {
    // Raised in review, and the sharpest finding in an SSOT-motivated change:
    // the logging path re-derived `notification_type || matcher` verbatim, so
    // adding a third source (or dropping the legacy alias) would have left the
    // log key silently disagreeing with the classification about one event.
    expect(matcherOf({ notification_type: 'Permission_Prompt' })).toBe('permission_prompt');
    expect(matcherOf({ matcher: 'IDLE_PROMPT' })).toBe('idle_prompt');  // legacy alias
    expect(matcherOf({ notification_type: 'a', matcher: 'b' })).toBe('a'); // newer wins
    expect(matcherOf({})).toBe('');
    expect(matcherOf(null)).toBe('');
    // And the classifier reads the same accessor, so the legacy field still
    // classifies — which is what stops the two from drifting.
    expect(classifyNotification({ matcher: 'auth_success' })).toBe(NOTIFICATION_KINDS.BENIGN);
  });

  test('BENIGN and UNKNOWN are distinct values, so the caller can tell them apart', () => {
    expect(NOTIFICATION_KINDS.BENIGN).not.toBe(NOTIFICATION_KINDS.UNKNOWN);
  });
});

test.describe('redactNotificationMessage — the wording survives, the specifics do not', () => {
  test('a Windows path is replaced, and the sentence around it is kept', () => {
    const out = redactNotificationMessage(
      'Claude wants to edit C:\\dev\\web-terminal\\server.js now');
    expect(out).toBe('Claude wants to edit <path> now');
  });

  test('a POSIX path is replaced without eating the space before it', () => {
    expect(redactNotificationMessage('reading /home/someone/.ssh/id_rsa please'))
      .toBe('reading <path> please');
  });

  test('a path at the very start is still caught', () => {
    expect(redactNotificationMessage('/var/log/secret.log changed')).toBe('<path> changed');
  });

  test('an inline slash is NOT a path — "and/or" survives', () => {
    // The redaction must not mangle ordinary prose; a `/` mid-word names nothing.
    expect(redactNotificationMessage('approve and/or deny')).toBe('approve and/or deny');
  });

  test('a URL is replaced WHOLE — it must not be eaten by the drive-path rule', () => {
    // Found by this spec: `http://x` ends in `p:/`, which is a valid Windows
    // drive-path match, so the drive rule bit into the scheme and produced
    // `htt<path>` — mangling the very wording the redaction exists to keep.
    expect(redactNotificationMessage('see http://x.io/a/b now')).toBe('see <url> now');
    expect(redactNotificationMessage('post to https://h/api/hook?t=abc'))
      .toBe('post to <url>');
  });

  test('a path CONTAINING a uuid is redacted WHOLE — the tail must not leak', () => {
    // Found in review, and the worst defect in this change. The uuid pass ran
    // FIRST and inserted `<id>`; every path rule excluded `<` and `>` from its
    // body, so each stopped dead at that marker and the filename after it
    // survived verbatim — as `<path><id>/secret.json`. Not a contrived shape:
    // `~/.claude/projects/<uuid>/…` IS the Claude layout, so a notification
    // naming a transcript is the likeliest payload there is.
    const out = redactNotificationMessage(
      'edit /home/someone/.claude/projects/9f46cb60-8df6-4748-85db-5aa254e2ac97/secret.json now');
    expect(out).toBe('edit <path> now');
    expect(out).not.toContain('secret.json');
    const url = redactNotificationMessage(
      'see https://h.io/s/9f46cb60-8df6-4748-85db-5aa254e2ac97/secret.json now');
    expect(url).toBe('see <url> now');
    expect(url).not.toContain('secret.json');
  });

  test('the path shapes a blocklist forgot are redacted too', () => {
    // Home-relative and dot-relative paths passed through COMPLETELY before the
    // rule became a token test rather than a list of shapes.
    expect(redactNotificationMessage('edit ~/.ssh/id_rsa now')).toBe('edit <path> now');
    expect(redactNotificationMessage('edit ./src/secret.env now')).toBe('edit <path> now');
    expect(redactNotificationMessage('edit ../../etc/shadow now')).toBe('edit <path> now');
    // A quoted path is still a path — and the quotes are WORDING, so they stay.
    expect(redactNotificationMessage('edit "/etc/passwd" now')).toBe('edit "<path>" now');
    // A UNC share.
    expect(redactNotificationMessage('\\\\server\\share\\x changed')).toBe('<path> changed');
  });

  test('punctuation around a path SURVIVES — the sentence must not be mangled', () => {
    // Raised in review. Replacing the whole token turned
    // `Bash(cat /home/a/.ssh/id_rsa)` into `Bash(cat <path>` — the closing paren
    // eaten. That is the same defect as the earlier `htt<path>`: a rule
    // swallowing the punctuation the wording is made of.
    expect(redactNotificationMessage('Bash(cat /home/a/.ssh/id_rsa)'))
      .toBe('Bash(cat <path>)');
    expect(redactNotificationMessage('edit "/etc/passwd", then stop'))
      .toBe('edit "<path>", then stop');
    // A label is wording too, and must not collapse into the marker.
    expect(redactNotificationMessage('path=/home/a/b.txt')).toBe('path=<path>');
    expect(redactNotificationMessage('file:/home/a/b.txt')).toBe('file:<path>');
    // ...but a drive letter is NOT a label, or `C:` would leak beside the path.
    // Deliberately NOT a `C:\Users\…` fixture: scripts/check-no-secrets.js treats
    // that shape as machine-identifying and failed CI on it. The right answer to
    // a security gate is a different fixture, never a new entry in its ALLOW list.
    expect(redactNotificationMessage('edit C:\\Data\\proj\\secret.txt'))
      .toBe('edit <path>');
  });

  test('a path with a SPACE in it leaks nothing — the ordinary Windows case', () => {
    // Raised in review. A whitespace-delimited token rule cannot see across a
    // space, so `C:\Program Files\secret.txt` had its drive half redacted and
    // its FILENAME written to the log verbatim as the next token. `Program
    // Files` / `My Documents` / OneDrive is the normal case, not a corner.
    for (const s of [
      'edit C:\\Program Files\\secret.txt now',
      'edit /opt/My Apps/secret.key now',
      'edit "C:\\a b\\c.txt" now',
      'edit src/secret.env now',
    ]) {
      const out = redactNotificationMessage(s);
      for (const leak of ['secret.txt', 'secret.key', 'c.txt', 'secret.env']) {
        expect(out, `leaked from: ${s}`).not.toContain(leak);
      }
    }
  });

  test('one slash with no extension is prose, with an extension is a path', () => {
    // The line the space fix walks: `src/secret.env` must redact while every one
    // of these must not. The extension is what separates them.
    for (const prose of ['and/or', '24/7', 'TODO/FIXME', 'either/or',
      'input/output', 'read/write', 'n/a', '9/10', 'a/b', 'ratio/x']) {
      expect(redactNotificationMessage(prose), prose).toBe(prose);
    }
    expect(redactNotificationMessage('config/prod.key')).toBe('<path>');
  });

  test('URL punctuation survives, and the test is not stateful', () => {
    // Two findings in one. The URL pass used to run over the whole string before
    // tokenising, and its `\\S*` swallowed the punctuation after it — the THIRD
    // time this module produced that defect. And the regex was `/g` while being
    // used with `.test()`, which advances lastIndex between calls, so the answer
    // depended on how many URLs had been seen before.
    expect(redactNotificationMessage('see (http://x.io/a) now')).toBe('see (<url>) now');
    expect(redactNotificationMessage('see http://x.io/a. Next')).toBe('see <url>. Next');
    const many = 'see http://a.io/x and http://b.io/y and http://c.io/z';
    const results = new Set();
    for (let i = 0; i < 10; i++) results.add(redactNotificationMessage(many));
    expect(results.size).toBe(1);
    expect([...results][0]).toBe('see <url> and <url> and <url>');
  });

  test('an email address never reaches the log', () => {
    expect(redactNotificationMessage('mail someone@example.com now'))
      .toBe('mail <email> now');
  });

  test('`~` marks a path only when it IS one', () => {
    // `about ~50 files` was reading as a path because a bare `~` prefix counted.
    expect(redactNotificationMessage('about ~50 files')).toBe('about ~50 files');
    expect(redactNotificationMessage('edit ~/x/y now')).toBe('edit <path> now');
  });

  test('quantities collapse, so one wording cannot mint unlimited shape keys', () => {
    // Raised in review, and it is what makes the capped table survivable: a
    // varying byte count or duration in one wording would otherwise fill the
    // table on its own, and a full table blinds the instrument permanently.
    expect(redactNotificationMessage('wrote 1024 bytes in 3.5s'))
      .toBe('wrote <n> bytes in <n>');
    expect(redactNotificationMessage('processed 1,048,576 items at 12:30'))
      .toBe('processed <n> items at <n>');
    // Version strings and percentages are quantities too, and were minting keys.
    expect(redactNotificationMessage('progress 87% on v1.72.3')).toBe('progress <n> on <n>');
    // Two different runs of the same wording now share ONE key.
    expect(redactNotificationMessage('wrote 12 bytes'))
      .toBe(redactNotificationMessage('wrote 98765 bytes'));
  });

  test('prose with a single slash is still prose', () => {
    // The exemption that keeps the feature worth having: the wording is the
    // entire product, so `and/or` must survive the rule that catches `a/b/c`.
    expect(redactNotificationMessage('approve and/or deny 24/7 TODO/FIXME'))
      .toBe('approve and/or deny 24/7 TODO/FIXME');
    expect(redactNotificationMessage('Claude needs your permission to run a command'))
      .toBe('Claude needs your permission to run a command');
  });

  test('a session uuid and a long hex token are replaced', () => {
    expect(redactNotificationMessage('session 9f46cb60-8df6-4748-85db-5aa254e2ac97 stalled'))
      .toBe('session <id> stalled');
    expect(redactNotificationMessage('token deadbeefcafebabe1234 rejected'))
      .toBe('token <hex> rejected');
  });

  test('newlines collapse to one line — a log entry is one line', () => {
    expect(redactNotificationMessage('first\n\nsecond   third')).toBe('first second third');
  });

  test('an over-long message is capped and marked', () => {
    const out = redactNotificationMessage('x'.repeat(500));
    expect(out.length).toBe(NOTIFICATION_MSG_CAP + 3);
    expect(out.endsWith('...')).toBe(true);
  });

  test('the cap is applied AFTER redaction, and this test can tell', () => {
    // Raised in review: `'x'.repeat(500)` passes identically whether the slice
    // happens before or after redacting, so it pinned nothing and a future edit
    // could reorder with the suite still green.
    //
    // This one discriminates. Redaction SHORTENS the text — a 300-char path
    // becomes six characters — so redact-then-cap keeps the whole sentence and
    // the trailing word survives. Cap-then-redact would slice mid-path, leaving
    // a truncated path fragment in the log and losing the tail entirely.
    const longPath = '/home/someone/' + 'deep/'.repeat(60) + 'secret.json';
    expect(longPath.length).toBeGreaterThan(NOTIFICATION_MSG_CAP);
    const out = redactNotificationMessage(`edit ${longPath} then stop`);
    expect(out).toBe('edit <path> then stop');
    expect(out).not.toContain('secret.json');
    expect(out).not.toContain('deep');
  });

  test('a non-string never throws and yields nothing', () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(redactNotificationMessage(/** @type {any} */(v))).toBe('');
    }
  });
});

test.describe('redactMatcher — the other external field, bounded too', () => {
  test('an ordinary matcher passes through, lowercased', () => {
    expect(redactMatcher('Permission_Prompt')).toBe('permission_prompt');
  });

  test('a huge matcher is capped — /api/hook accepts a 256 kB body', () => {
    // Found in review: the message was redacted and capped and the matcher was
    // interpolated RAW, into both the log line and the map key. That is an
    // unbounded write per occurrence and an unbounded key.
    const out = redactMatcher('m'.repeat(50000));
    expect(out.length).toBe(NOTIFICATION_MATCHER_CAP + 3);
    expect(out.endsWith('...')).toBe(true);
  });

  test('a matcher carrying a path is redacted like any other external text', () => {
    expect(redactMatcher('/home/someone/secret.json')).toBe('<path>');
  });

  test('an absent matcher is named, not blank', () => {
    for (const v of [undefined, null, '']) {
      expect(redactMatcher(/** @type {any} */(v))).toBe('(none)');
    }
  });
});

test.describe('noteShape — the cap must not become the flood', () => {
  test('repeat sightings of one shape count up', () => {
    const m = new Map();
    expect(noteShape(m, 'a', 10)).toBe(1);
    expect(noteShape(m, 'a', 10)).toBe(2);
    expect(noteShape(m, 'b', 10)).toBe(1);
    expect(m.size).toBe(2);
  });

  test('a NEW shape at a FULL table returns 0 — and 0 never logs', () => {
    // THE regression. The first cut left an over-cap key out of the map and then
    // recomputed `n` from the missing entry, so it was 1 EVERY time — and
    // `shouldLogDrop(1)` is true, so the bound that exists to prevent a flood
    // produced one: every single occurrence of every shape past the cap.
    const m = new Map();
    for (let i = 0; i < 3; i++) noteShape(m, `k${i}`, 3);
    expect(m.size).toBe(3);
    for (let i = 0; i < 5; i++) {
      expect(noteShape(m, 'overflow', 3)).toBe(0);
      expect(shouldLogDrop(noteShape(m, 'overflow', 3))).toBe(false);
    }
    // The table did not grow either — that was the other half of the cap's job.
    expect(m.size).toBe(3);
  });

  test('a shape ALREADY counted keeps counting after the table fills', () => {
    // The cap bounds distinct keys, never the count of a key already known —
    // otherwise a shape would go silent precisely when it became frequent.
    const m = new Map();
    noteShape(m, 'known', 2);
    noteShape(m, 'other', 2);
    expect(noteShape(m, 'fresh', 2)).toBe(0);
    expect(noteShape(m, 'known', 2)).toBe(2);
  });
});

test.describe('noteDrop — the whole decision, and therefore testable', () => {
  const MAX = 3;

  test('an ordinary shape logs on 1 and 100, and is silent between', () => {
    const st = newDropState();
    expect(noteDrop(st, 'a', MAX).action).toBe('log');
    for (let i = 2; i < 100; i++) expect(noteDrop(st, 'a', MAX).action).toBe('silent');
    const hundredth = noteDrop(st, 'a', MAX);
    expect(hundredth.action).toBe('log');
    expect(hundredth.n).toBe(100);
  });

  test('the table filling is announced exactly ONCE', () => {
    // The map never evicts, so it stays full for the process's life; re-arming
    // would repeat a line carrying no new information.
    const st = newDropState();
    for (let i = 0; i < MAX; i++) noteDrop(st, `k${i}`, MAX);
    expect(noteDrop(st, 'new1', MAX).action).toBe('full');
    expect(noteDrop(st, 'new2', MAX).action).toBe('silent');
    expect(noteDrop(st, 'new3', MAX).action).toBe('silent');
  });

  test('uncountable volume is TALLIED, not silently thrown away', () => {
    // Raised in review: failing closed traded a flood for a blind spot, and the
    // module's own comment still claimed "the count rides along so volume is
    // never lost" while these were discarded with no record at all.
    const st = newDropState();
    for (let i = 0; i < MAX; i++) noteDrop(st, `k${i}`, MAX);
    expect(noteDrop(st, 'x0', MAX).action).toBe('full');       // uncountable = 1
    let tallies = 0;
    for (let i = 1; i < 200; i++) {
      const d = noteDrop(st, `x${i}`, MAX);
      if (d.action === 'tally') { tallies++; expect(d.uncountable % 100).toBe(0); }
    }
    // The 100th and the 200th — bounded, but never silent.
    expect(tallies).toBe(2);
    expect(st.uncountable).toBe(200);
  });

  test('a shape already counted keeps logging after the table fills', () => {
    // The cap bounds DISTINCT keys. A known shape must not go quiet precisely
    // when it becomes frequent.
    const st = newDropState();
    for (let i = 0; i < MAX; i++) noteDrop(st, `k${i}`, MAX);
    noteDrop(st, 'overflow', MAX);
    for (let i = 2; i < 100; i++) noteDrop(st, 'k0', MAX);
    expect(noteDrop(st, 'k0', MAX)).toMatchObject({ action: 'log', n: 100 });
  });

  test('a fresh state bag shares nothing with another', () => {
    const a = newDropState();
    const b = newDropState();
    noteDrop(a, 'k', MAX);
    expect(b.counts.size).toBe(0);
    expect(b.full).toBe(false);
  });
});

test.describe('shouldLogDrop — bounded, so a wrong guess cannot flood a disk', () => {
  test('the first sighting always logs', () => {
    expect(shouldLogDrop(1)).toBe(true);
  });

  test('the next ninety-eight do not', () => {
    for (let n = 2; n < 100; n++) expect(shouldLogDrop(n)).toBe(false);
  });

  test('then every hundredth, so volume is never lost', () => {
    expect(shouldLogDrop(100)).toBe(true);
    expect(shouldLogDrop(101)).toBe(false);
    expect(shouldLogDrop(200)).toBe(true);
  });

  test('a zero or negative count logs nothing', () => {
    expect(shouldLogDrop(0)).toBe(false);
    expect(shouldLogDrop(-100)).toBe(false);
  });
});
