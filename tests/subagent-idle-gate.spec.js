// @ts-check
// Issue #61 — a main agent that stops while its subagents are still running must
// NOT report the session as idle, and must NOT fire the "Claude is done" push.
//
// Before the fix: Stop → status idle + an 'idle' notification, every time the main
// agent ended a turn — even with two background subagents still working. The dot
// lied and the phone buzzed. SubagentStop was dropped by the server's transform
// layer, so nothing counted the subagents in flight.
//
// After: the worker (the SSOT for status) counts SubagentStart/SubagentStop and
// holds the main agent's Stop until the last subagent finishes.
//
// These tests drive the REAL path: HTTP hook endpoint → server transform → worker,
// and read status back off /api/sessions and the idle notification off /ws/notify
// (the same frame the ntfy push is gated on).
const { test, expect, request: pwRequest } = require('@playwright/test');
const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };
// The suite runs the server with WT_HOOK_STOP_DEBOUNCE_MS=200 (playwright.config.js).
const DEBOUNCE_MS = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 200;
const SLACK_MS = 500;

/** Log in over raw http and return the cookie — used for BOTH the API context and
 *  the ws upgrade, so the whole file costs exactly one login. */
function rawCookie() {
  return new Promise((resolve, reject) => {
    const body = `user=${encodeURIComponent(AUTH.user)}&password=${encodeURIComponent(AUTH.password)}`;
    const req = http.request(
      BASE + '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const sc = res.headers['set-cookie'];
        res.resume();
        if (!sc) return reject(new Error('no set-cookie on login'));
        resolve(sc.map((c) => c.split(';')[0]).join('; '));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** The hook endpoint takes the raw Claude payload; no cookie (hooks are local). */
async function sendHook(raw, id, event, extra = {}) {
  const res = await raw.post(`/api/session/${id}/hook`, { data: { event, ...extra } });
  expect(res.ok(), `hook ${event} should be accepted`).toBeTruthy();
  return res.json();
}

// An event raised INSIDE a subagent. Claude stamps every one of these with agent_id
// (+ agent_type) and stamps NO main-agent event with it — captured from the real
// hook stream of a backgrounded Task:
//   PreToolUse Agent [main] → SubagentStart [sub] → PostToolUse Agent [main]
//   → Stop [main] → (13s later) SubagentStop [sub]
// That Stop, 13 seconds before the subagent finished, is the bug in #61.
const sub = (agentId, extra = {}) => ({ agent_id: agentId, agent_type: 'general-purpose', ...extra });

async function getStatus(ctx, id) {
  const list = await (await ctx.get('/api/sessions')).json();
  const s = (Array.isArray(list) ? list : list.sessions || []).find((x) => x.id === id);
  return s ? s.status : null;
}

test.describe('#61 — Stop while subagents are in flight', () => {
  let ctx, raw, ws, frames, id;

  /** Every 'idle' ("Claude stopped / is done") notification seen for this session —
   *  the exact frame the ntfy push is gated on, so an empty list means no push. */
  const idleFrames = (sid) => frames
    .map((f) => f.notification || f)
    .filter((n) => n && n.type === 'idle' && n.sessionId === sid);

  test.beforeAll(async () => {
    const cookie = await rawCookie();
    ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: cookie } });
    raw = await pwRequest.newContext({ baseURL: BASE });
    frames = [];
    // One live notify socket for the file, standing in for the phone/browser that
    // would be pushed to. Frames are filtered per session id, so tests can't bleed.
    ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/notify', { headers: { Cookie: cookie } });
    ws.on('message', (d) => {
      try { frames.push(JSON.parse(d.toString())); } catch { /* ignore non-JSON */ }
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  });

  test.afterAll(async () => {
    if (ws) ws.close();
    if (ctx) await ctx.dispose();
    if (raw) await raw.dispose();
  });

  test.beforeEach(async () => {
    const res = await ctx.post('/api/sessions', { data: { name: `Subagent61-${Date.now()}` } });
    id = (await res.json()).id;
    expect(id).toBeTruthy();
  });

  test.afterEach(async () => {
    if (id) await ctx.delete(`/api/sessions/${id}`);
    id = null;
  });

  test('main-agent Stop with 2 subagents running: stays working, no idle push', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'SubagentStart', sub('a2'));
    expect(await getStatus(ctx, id)).toBe('working');

    // The main agent ends its turn while both subagents keep running.
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));

    // Before the fix: 'idle' + a "Claude stopped" notification here.
    expect(await getStatus(ctx, id)).toBe('working');
    expect(idleFrames(id), 'no idle notification while subagents run').toHaveLength(0);
  });

  test('the LAST SubagentStop releases the held stop: idle, exactly one notification', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'SubagentStart', sub('a2'));
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('working');

    // First subagent finishes — one is still running, so still not done.
    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('working');
    expect(idleFrames(id)).toHaveLength(0);

    // The last one finishes — NOW the session is genuinely done.
    await sendHook(raw, id, 'SubagentStop', sub('a2'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('idle');
    expect(idleFrames(id), 'exactly one "done" notification').toHaveLength(1);
  });

  test("a subagent's own tool calls never cancel the held stop", async () => {
    // A subagent's PreToolUse/PostToolUse post under the PARENT's session id. The
    // first cut of this fix read them as "the main agent is working" and threw the
    // parent's real Stop away. They carry agent_id; main-agent events do not.
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'Stop');

    // The subagent keeps calling tools right through the debounce window.
    await sendHook(raw, id, 'PreToolUse', sub('a1', { tool_name: 'Bash' }));
    await sendHook(raw, id, 'PostToolUse', sub('a1', { tool_name: 'Bash' }));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('working');
    expect(idleFrames(id)).toHaveLength(0);

    // It finishes: the held stop must still be there to release.
    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'the held stop must survive subagent tool calls').toBe('idle');
    expect(idleFrames(id)).toHaveLength(1);
  });

  test('the MAIN agent resuming DOES invalidate the held stop (no phantom "done" later)', async () => {
    // The mirror image: if the parent picks the turn back up, the stop we parked is
    // stale. Releasing it when the last subagent exits would push "Claude stopped"
    // while Claude is mid-turn. A main-agent event (no agent_id) drops the hold; the
    // parent's own next Stop is what ends the turn.
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'Stop');           // held
    await sendHook(raw, id, 'PreToolUse', { tool_name: 'Read' }); // MAIN agent resumes

    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'the parent is working — not done').toBe('working');
    expect(idleFrames(id), 'no phantom "done" while the main agent works').toHaveLength(0);

    // The parent's real Stop ends the turn.
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('idle');
    expect(idleFrames(id)).toHaveLength(1);
  });

  test('a duplicate SubagentStart, and a SubagentStop for an unknown id, cannot skew tracking', async () => {
    // Tracked as a SET of agent_ids: the same id twice is one subagent, and a stop
    // for an id we never saw does not drive a counter negative (which would let the
    // NEXT Stop through while a real subagent was still running).
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'SubagentStart', sub('a1'));   // duplicate — still ONE
    await sendHook(raw, id, 'SubagentStop', sub('ghost')); // never started
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'a1 is still running').toBe('working');
    expect(idleFrames(id)).toHaveLength(0);

    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('idle');
    expect(idleFrames(id)).toHaveLength(1);
  });

  test('a permission prompt raised by the subagent does not strand the held stop', async () => {
    // The subagent asks for approval and then exits with the prompt still on screen.
    // The main agent already stopped, so once nothing is in flight the turn IS over —
    // the held stop must still be delivered rather than left parked on 'waiting'
    // forever (where only the 5-min stale guard, which fires no push, would free it).
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'Stop'); // held
    await sendHook(raw, id, 'PermissionRequest', sub('a1'));
    expect(await getStatus(ctx, id)).toBe('waiting');

    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'nothing is running — the turn is done').toBe('idle');
    expect(idleFrames(id)).toHaveLength(1);
  });

  test('no subagents: Stop still goes idle and notifies (no regression)', async () => {

    await sendHook(raw, id, 'UserPromptSubmit');
    expect(await getStatus(ctx, id)).toBe('working');

    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));

    expect(await getStatus(ctx, id)).toBe('idle');
    expect(idleFrames(id)).toHaveLength(1);
  });

  test('a subagent that dies without SubagentStop cannot pin the session: a new user turn resets tracking', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('working'); // deferred — subagent still "in flight"

    // The subagent never reports SubagentStop (crashed / abandoned). The user
    // starts a new turn, which ends the old one — the tracking must go with it.
    await sendHook(raw, id, 'UserPromptSubmit');
    expect(await getStatus(ctx, id)).toBe('working');

    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'stale tracking must not survive a new turn').toBe('idle');
  });

  test('the stale-status safety net still frees a session whose subagent tracking is stuck', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('working');

    // Nothing has spoken for 10 minutes: no hook, no output. Whatever the tracking
    // says, nothing is running — the existing 5-min net corrects it.
    const aged = await ctx.post(`/api/test/age-session/${id}`, { data: { ageMinutes: 10 } });
    expect((await aged.json()).ok).toBeTruthy();

    expect(await getStatus(ctx, id)).toBe('idle');
  });

  // #239 — THE SECOND PATH TO "THE LENS SHOWED NOTHING", one layer below #236.
  //
  // #236 fixed a subagent's PreToolUse erasing the MAIN agent's live question in
  // server.js. This is the same symptom reached in the WORKER, and #236's fix
  // deliberately does not touch it: an idle Notification arriving while subagents are
  // in flight is parked as `session.heldStop` and `break`s BEFORE the #98 question
  // check, then the last SubagentStop hands it to armIdle — which had no such check
  // anywhere on its path. So the SUBAGENT finishing idled a session blocked on the
  // main agent's question: `waitingFor` goes null (no #79 banner), the dot goes calm,
  // and only #194's terminal tail strip is left.
  //
  // The precondition is routine rather than exotic: `Notification held` appears 365
  // times in this machine's worker log since #61's hold shipped. What was unobserved
  // is only the coincidence with a live question — which is exactly what this drives.
  //
  // The polarity check that makes it worth pinning: a held `Stop` is safe BY ACCIDENT,
  // because server.js classifies Stop as an event that resolves a question and sends
  // questionPending:false with it. A `Notification` sends nothing (#98's tri-state), so
  // the flag survives the hold. Of the two events that can be held, exactly one is
  // dangerous — and it is the more frequent kind of block.
  test('#239: a held idle Notification released by SubagentStop does NOT idle a session owing an answer', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));

    // The main agent asks a question while its subagent runs — #236's shape exactly.
    await sendHook(raw, id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ header: 'Approach', question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    expect(await getStatus(ctx, id), 'a pending question reads as waiting (#112)').toBe('waiting');

    // Claude raises its idle Notification ~60s into an unanswered question. With a
    // subagent in flight it is HELD, so the case's own question check never runs.
    await sendHook(raw, id, 'Notification', { message: 'Claude is waiting for your input' });
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('waiting');

    // The subagent finishes. THIS is the line that was red: the held Notification was
    // released into armIdle -> applyIdle with the question still on screen.
    await sendHook(raw, id, 'SubagentStop', sub('a1'));
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'a subagent finishing does not answer the main agent\'s question').toBe('waiting');
    expect(idleFrames(id), 'no "Claude is done" push for a session that owes an answer').toHaveLength(0);

    // The chat lens's own signal, not just the dot: #79's banner is `waitingFor`, and
    // it is derived from status AND a captured question, so an idle here silences the
    // banner and the #19 overlay together — which is why the report was "no indication".
    const row = (await (await ctx.get('/api/sessions')).json()).find((x) => x.id === id);
    expect(row.waitingFor, 'the chat lens must still name what it is waiting for').toBe('question');
  });

  // The guard must not pin a session non-idle for the rest of its life - the same
  // sibling check #98 carries one layer up. Note the ORDER here is deliberate and the
  // first draft of this test got it wrong: answering BEFORE the SubagentStop makes the
  // session end up `working`, and correctly so, because a main-agent PostToolUse drops
  // the held event outright (a parent that picked its turn back up must not be handed a
  // stale 'done' when the subagent exits). That is #61 working, not #239 - so the honest
  // shape is to let the release be REFUSED first, then answer, then send a fresh idle.
  test('#239: once the question is answered, the session idles normally again', async () => {
    await sendHook(raw, id, 'UserPromptSubmit');
    await sendHook(raw, id, 'SubagentStart', sub('a1'));
    await sendHook(raw, id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ header: 'Approach', question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    await sendHook(raw, id, 'Notification', { message: 'Claude is waiting for your input' });
    await sendHook(raw, id, 'SubagentStop', sub('a1'));   // released, and refused
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id)).toBe('waiting');

    // Answered - the flag clears, and the NEXT idle event is an ordinary end of turn.
    await sendHook(raw, id, 'PostToolUse', { tool_name: 'AskUserQuestion' });
    await sendHook(raw, id, 'Stop');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
    expect(await getStatus(ctx, id), 'an answered question must not pin the session').toBe('idle');
  });

});
