// @ts-check
// Two Codex sessions in ONE working directory must resolve to DIFFERENT conversations.
//
// The report (Office, 2026-07-22): `Codex bug hunter` and `Codex setup sql fix 22421`
// both ran in C:\dev\am8_core, and BOTH reported agentSessionId
// 019f8928-94e9-7072-93d3-271f00fbaea7 — so the dead session's chat lens showed the live
// session's conversation while its terminal correctly showed nothing. The terminal was
// honest; the chat was not.
//
// Cause: a Codex rollout is keyed by date+uuid, never by cwd, so resolution was "newest
// rollout whose session_meta.cwd matches" — which silently assumes one Codex per folder.
//
// Fix: a codex process creates exactly ONE rollout when it starts, and the filename
// carries that start time, so the session's own process start selects its own rollout.
const { test, expect } = require('@playwright/test');
const { rolloutStartMs, pickRolloutForProcessStart } = require('../lib/codex-match');
const { descendantsOf, newestDescendantNamed } = require('../lib/process-tree');
const { findRolloutForCwd } = require('../lib/codex-sessions');

// Local time, deliberately — see the codex-match header. Office (UTC+3) wrote
// `rollout-2026-07-21T16-47-43-…` with an mtime of 13:51Z.
const localMs = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();
const roll = (iso, uuid) => `C:\\U\\.codex\\sessions\\2026\\07\\22\\rollout-${iso}-${uuid}.jsonl`;
const UUID_A = '019f8928-94e9-7072-93d3-271f00fbaea7'; // the live one on Office
const UUID_B = '019f8949-1a6c-7243-85f3-504c0566207a'; // the other, 3s apart by mtime

test.describe('rolloutStartMs', () => {
  test('parses the filename stamp as LOCAL time', () => {
    expect(rolloutStartMs(roll('2026-07-22T10-07-16', UUID_A)))
      .toBe(localMs(2026, 7, 22, 10, 7, 16));
  });

  test('parsing it as UTC would be wrong — this pins local', () => {
    // Date.parse('2026-07-22T10:07:16Z') is the UTC reading; on any machine with a
    // non-zero offset the two differ, and matching would land on the wrong file.
    const local = rolloutStartMs(roll('2026-07-22T10-07-16', UUID_A));
    const asUtc = Date.parse('2026-07-22T10:07:16Z');
    if (new Date().getTimezoneOffset() !== 0) expect(local).not.toBe(asUtc);
  });

  test('non-rollout paths yield null', () => {
    expect(rolloutStartMs('C:\\dev\\notes.txt')).toBeNull();
    expect(rolloutStartMs('')).toBeNull();
    expect(rolloutStartMs(null)).toBeNull();
  });
});

test.describe('pickRolloutForProcessStart', () => {
  const A = { path: roll('2026-07-22T10-07-16', UUID_A) };
  const B = { path: roll('2026-07-22T09-30-00', UUID_B) };

  test('picks the rollout created when THIS process started', () => {
    const hit = pickRolloutForProcessStart([A, B], localMs(2026, 7, 22, 10, 7, 15));
    expect(hit.path).toBe(A.path);
    expect(hit.ambiguous).toBe(false);
  });

  test('a different process start selects the OTHER rollout — the whole point', () => {
    const hit = pickRolloutForProcessStart([A, B], localMs(2026, 7, 22, 9, 29, 58));
    expect(hit.path).toBe(B.path);
  });

  test('a rollout created BEFORE the process cannot belong to it', () => {
    // Only the small negative slack for clock skew is allowed, not a symmetric window.
    expect(pickRolloutForProcessStart([B], localMs(2026, 7, 22, 10, 0, 0))).toBeNull();
  });

  test('too far after the process start is not a match', () => {
    expect(pickRolloutForProcessStart([A], localMs(2026, 7, 22, 9, 0, 0))).toBeNull();
  });

  test('two rollouts started at nearly the same instant are AMBIGUOUS', () => {
    // Guessing here would recreate the bug: one session shown another's conversation.
    const near = { path: roll('2026-07-22T10-07-17', UUID_B) };
    const hit = pickRolloutForProcessStart([A, near], localMs(2026, 7, 22, 10, 7, 16));
    expect(hit.ambiguous).toBe(true);
  });

  test('no process start means no opinion', () => {
    expect(pickRolloutForProcessStart([A, B], null)).toBeNull();
  });
});

test.describe('descendantsOf / newestDescendantNamed', () => {
  // The real shape from Office: the PTY is bash, which spawns bash, which spawns codex.
  const PROCS = [
    { pid: 46932, ppid: 1, name: 'bash.exe', startMs: 1000 },
    { pid: 5400, ppid: 46932, name: 'bash.exe', startMs: 2000 },
    { pid: 11004, ppid: 5400, name: 'codex.exe', startMs: 3000 },
    { pid: 20624, ppid: 999, name: 'codex.exe', startMs: 4000 }, // another session's
  ];

  test('walks NESTED descendants — the agent is not a direct child', () => {
    // Numeric sort — a bare .sort() compares as strings, so 11004 would precede 5400.
    expect(descendantsOf(PROCS, 46932).map((p) => p.pid).sort((a, b) => a - b))
      .toEqual([5400, 11004]);
  });

  test('finds this session codex and ignores another session codex', () => {
    const hit = newestDescendantNamed(PROCS, 46932, 'codex.exe');
    expect(hit.pid).toBe(11004);
  });

  test('a session whose agent has exited reports none', () => {
    // Exactly the dead `Codex bug hunter`: its PTY had only a shell under it. Reporting
    // none is correct — it is what stops the empty session borrowing a live one.
    const dead = [{ pid: 46932, ppid: 1, name: 'bash.exe', startMs: 1 },
      { pid: 5400, ppid: 46932, name: 'bash.exe', startMs: 2 }];
    expect(newestDescendantNamed(dead, 46932, 'codex.exe')).toBeNull();
  });

  test('re-running the agent picks the NEWEST process, not the finished one', () => {
    const twice = PROCS.concat([{ pid: 7777, ppid: 5400, name: 'codex.exe', startMs: 9000 }]);
    expect(newestDescendantNamed(twice, 46932, 'codex.exe').pid).toBe(7777);
  });

  test('a cyclic parent chain terminates', () => {
    const cyclic = [{ pid: 2, ppid: 1, name: 'a', startMs: 1 }, { pid: 1, ppid: 2, name: 'b', startMs: 1 }];
    expect(() => descendantsOf(cyclic, 1)).not.toThrow();
  });
});

test.describe('findRolloutForCwd — the Office scenario end to end', () => {
  const CWD = 'C:\\dev\\am8_core';
  const pA = roll('2026-07-22T10-07-16', UUID_A);
  const pB = roll('2026-07-22T09-30-00', UUID_B);
  // Both rollouts are in the SAME cwd. mtime order puts A first — which is exactly why
  // the old rule handed A to both sessions.
  const io = {
    listRollouts: () => [{ path: pA, mtimeMs: 2000 }, { path: pB, mtimeMs: 1000 }],
    readFirstLine: () => JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } }),
  };
  const opts = { platform: 'win32' };

  test('WITHOUT a process hint both sessions collapse onto one rollout (the bug)', () => {
    expect(findRolloutForCwd(CWD, io, opts)).toBe(pA);
  });

  test('WITH each session process start, the two sessions get DIFFERENT rollouts', () => {
    const sessionOne = findRolloutForCwd(CWD, io, { ...opts, processStartMs: localMs(2026, 7, 22, 10, 7, 15) });
    const sessionTwo = findRolloutForCwd(CWD, io, { ...opts, processStartMs: localMs(2026, 7, 22, 9, 29, 59) });
    expect(sessionOne).toBe(pA);
    expect(sessionTwo).toBe(pB);
    expect(sessionOne).not.toBe(sessionTwo);
  });

  test('a session whose codex has exited gets NOTHING, not a live session conversation', () => {
    // `Codex bug hunter`: its process was gone, so there is no start time to match. The
    // honest answer is an empty lens — showing the other session's work is the defect.
    expect(findRolloutForCwd(CWD, io, { ...opts, processStartMs: localMs(2026, 7, 22, 4, 0, 0) })).toBe('');
  });

  test('ambiguous starts yield nothing rather than a coin flip', () => {
    const near = {
      listRollouts: () => [{ path: roll('2026-07-22T10-07-16', UUID_A), mtimeMs: 2 },
        { path: roll('2026-07-22T10-07-17', UUID_B), mtimeMs: 1 }],
      readFirstLine: () => JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } }),
    };
    expect(findRolloutForCwd(CWD, near, { ...opts, processStartMs: localMs(2026, 7, 22, 10, 7, 16) })).toBe('');
  });

  test('a cwd with no rollouts is still empty', () => {
    expect(findRolloutForCwd('C:\\dev\\elsewhere', io, { ...opts, processStartMs: Date.now() })).toBe('');
  });
});

test.describe('findRolloutById — the exact answer from codex-notify', () => {
  const { findRolloutById } = require('../lib/codex-sessions');
  const pA = roll('2026-07-22T10-07-16', UUID_A);
  const pB = roll('2026-07-22T09-30-00', UUID_B);
  const io = { listRollouts: () => [{ path: pA, mtimeMs: 2 }, { path: pB, mtimeMs: 1 }] };

  test('resolves by conversation id regardless of cwd or mtime order', () => {
    // The point: no cwd guessing and no newest-wins. B is OLDER and would never win the
    // ranking, yet it is the correct answer for the session that owns it.
    expect(findRolloutById(UUID_B, io)).toBe(pB);
    expect(findRolloutById(UUID_A, io)).toBe(pA);
  });

  test('two sessions with reported ids never collide, however many share a folder', () => {
    expect(findRolloutById(UUID_A, io)).not.toBe(findRolloutById(UUID_B, io));
  });

  test('an unknown id resolves to nothing rather than the newest', () => {
    expect(findRolloutById('019f0000-0000-7000-8000-000000000000', io)).toBe('');
  });

  test('a non-uuid is rejected — it must never become a path fragment', () => {
    expect(findRolloutById('../../etc/passwd', io)).toBe('');
    expect(findRolloutById('', io)).toBe('');
    expect(findRolloutById(null, io)).toBe('');
  });
});

test.describe('the codex provider prefers a reported id over any guess', () => {
  const agents = require('../lib/agents');
  const CWD = 'C:\dev\am8_core';
  const pA = roll('2026-07-22T10-07-16', UUID_A);
  const pB = roll('2026-07-22T09-30-00', UUID_B);
  const io = {
    root: 'r',
    join: require('path').join,
    listRollouts: () => [{ path: pA, mtimeMs: 2000 }, { path: pB, mtimeMs: 1000 }],
    readFirstLine: () => JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } }),
  };
  const codex = agents.getAdapter('codex');

  test('a reported conversationId wins over newest-in-cwd', () => {
    // Without the id this session would be handed pA (newest) — the exact collision
    // seen on Office. With it, it gets its own.
    expect(codex.resolveTranscript({ cwd: CWD, conversationId: UUID_B }, io)).toBe(pB);
  });

  test('no reported id falls back to the previous behaviour, not to nothing', () => {
    // notify only reports once a turn COMPLETES, so a session mid-first-turn must still
    // resolve something rather than showing an empty lens.
    expect(codex.resolveTranscript({ cwd: CWD }, io)).toBe(pA);
  });
});

test.describe('a session is never handed a conversation that is not its own', () => {
  const CWD = 'C:\dev\am8_core';
  const pUser = roll('2026-07-22T10-07-16', UUID_A);
  const pSub = roll('2026-07-22T09-30-00', UUID_B);
  const meta = (id, threadSource) => JSON.stringify({
    type: 'session_meta', payload: { id, cwd: CWD, thread_source: threadSource },
  });
  const io = {
    listRollouts: () => [{ path: pSub, mtimeMs: 3000 }, { path: pUser, mtimeMs: 1000 }],
    // The SUBAGENT is newer, so mtime ranking would pick it.
    readFirstLine: (p) => (p === pSub ? meta(UUID_B, 'subagent') : meta(UUID_A, 'user')),
  };
  const opts = { platform: 'win32' };

  test('a SUBAGENT rollout is never resolved as a session conversation', () => {
    // Measured on Office: two of the three rollouts in one cwd were subagents, and the
    // newest of them would have won on mtime. A subagent is a child of a conversation,
    // not a conversation — its session_id points at the parent.
    expect(findRolloutForCwd(CWD, io, opts)).toBe(pUser);
  });

  test('a conversation CLAIMED by another session is skipped', () => {
    // The freshly-opened-session case: Codex writes no rollout until its first turn
    // STARTS, so a new session owns nothing yet and mtime would hand it the neighbour's.
    const claimed = new Set([UUID_A]);
    expect(findRolloutForCwd(CWD, io, { ...opts, claimedIds: claimed })).toBe('');
  });

  test('its OWN claim is not skipped — only other sessions claims are', () => {
    // claimedIds carries only OTHER sessions ids, so a session that owns UUID_A still
    // resolves it through the exact path.
    expect(findRolloutForCwd(CWD, io, { ...opts, claimedIds: new Set() })).toBe(pUser);
  });

  test('parseSessionMeta exposes thread_source', () => {
    const { parseSessionMeta } = require('../lib/transcript-codex');
    expect(parseSessionMeta(meta(UUID_B, 'subagent')).threadSource).toBe('subagent');
    expect(parseSessionMeta(meta(UUID_A, 'user')).threadSource).toBe('user');
    // Absent on older rollouts — must not be treated as a subagent.
    expect(parseSessionMeta(JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } })).threadSource).toBe('');
  });
});
