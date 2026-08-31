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
  classifyNotification,
  redactNotificationMessage,
  noteShape,
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

  test('a non-string never throws and yields nothing', () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(redactNotificationMessage(/** @type {any} */(v))).toBe('');
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
