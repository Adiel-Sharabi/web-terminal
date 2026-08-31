// @ts-check
// #146 — one PTY, many viewers, ONE size: the smallest ACTIVE viewer wins.
//
// The bug was reported as "Agent View renders very bad on the phone", and its filed
// mechanism (the alternate screen buffer / ConPTY coalescing positioned writes) was
// measured and disproved — see lib/terminal-size.js for the captures. The real cause is
// width: the PTY size was LAST-WRITER-WINS, so a desktop relaying out (window resize,
// sidebar toggle, compose bar growing) stole the columns back from a phone seconds after
// it attached, and the phone then wrapped a 120-column frame into 52.
//
// GROUND TRUTH, not a proxy: these tests ask the PTY itself, with `stty size`, and read
// the answer out of the session's scrollback. No API reports the PTY's dimensions, and
// asserting on the resize message we sent would only prove we sent it.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const { BASE, AUTH, authCtx, emptyCwd } = require('./test-helpers');
const { negotiateSize, sizeChanged } = require('../lib/terminal-size');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('negotiateSize — the pure rule', () => {
  test('one viewer sets the size', () => {
    expect(negotiateSize([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 });
  });

  test('THE RULE: the smallest viewer wins, per dimension', () => {
    // A terminal smaller than its viewer wastes space; one LARGER than its viewer is
    // unreadable. Only the second loses information, so the minimum is the safe answer.
    expect(negotiateSize([
      { cols: 120, rows: 40 },
      { cols: 52, rows: 30 },
    ])).toEqual({ cols: 52, rows: 30 });
  });

  test('the two dimensions are minimised independently', () => {
    // A tall narrow phone next to a short wide window: the PTY has to fit inside both.
    expect(negotiateSize([
      { cols: 200, rows: 20 },
      { cols: 52, rows: 60 },
    ])).toEqual({ cols: 52, rows: 20 });
  });

  test('a BACKGROUND viewer has no vote', () => {
    // Otherwise a phone left open in a pocket holds a desktop session at phone width
    // forever. It is also what makes the fix self-healing: backgrounding gives the
    // columns back.
    expect(negotiateSize([
      { cols: 120, rows: 40 },
      { cols: 52, rows: 30, background: true },
    ])).toEqual({ cols: 120, rows: 40 });
  });

  test('a viewer with no reported size has no vote', () => {
    // A REST client or a socket that never sent a resize has no opinion. Treating an
    // absent size as a small default would shrink the PTY for everybody.
    expect(negotiateSize([
      { cols: 120, rows: 40 },
      {},
      { cols: null, rows: null },
    ])).toEqual({ cols: 120, rows: 40 });
  });

  test('half a reading is not a viewer size', () => {
    // Mixing one socket's columns with another's rows would describe a window nobody
    // has, so a viewer missing either dimension is skipped entirely.
    expect(negotiateSize([
      { cols: 120, rows: 40 },
      { cols: 52 },
    ])).toEqual({ cols: 120, rows: 40 });
  });

  test('nobody with an opinion means NO ANSWER, never a default', () => {
    // The caller must leave the PTY alone. Returning 80x24 here would resize a live
    // agent's screen because a REST client connected.
    expect(negotiateSize([])).toBeNull();
    expect(negotiateSize([{ background: true, cols: 52, rows: 30 }])).toBeNull();
    expect(negotiateSize(null)).toBeNull();
  });

  test('out-of-range sizes are ignored rather than clamped', () => {
    // The clamp belongs to the transport (server.js / pty-worker.js both bound the
    // message). A value outside it here means a bad reading, and honouring it as a
    // clamped 1 column would be far worse than skipping that viewer.
    expect(negotiateSize([
      { cols: 120, rows: 40 },
      { cols: 0, rows: 30 },
      { cols: 9999, rows: 30 },
    ])).toEqual({ cols: 120, rows: 40 });
  });

  test('sizeChanged suppresses the no-op RPC every relayout would otherwise cost', () => {
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 52, rows: 24 })).toBe(true);
    expect(sizeChanged(undefined, { cols: 80, rows: 24 })).toBe(true);
    expect(sizeChanged({ cols: 80, rows: 24 }, null)).toBe(false);
  });
});

// --- end to end, against the real PTY ---------------------------------------

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** An ACTIVE viewer socket that can state a window size, exactly as a browser does. */
async function viewer(cookie, id, cols, rows) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ mode: 'active', browserId: `sz-${cols}x${rows}-${Math.random()}` }));
  await sleep(250);
  const setSize = async (c, r) => { ws.send(JSON.stringify({ resize: { cols: c, rows: r } })); await sleep(400); };
  if (cols) await setSize(cols, rows);
  return {
    ws,
    setSize,
    background: async () => { ws.send(JSON.stringify({ mode: 'background' })); await sleep(400); },
    type: (s) => ws.send(s),
    close: () => new Promise((r) => { ws.once('close', r); try { ws.close(); } catch { r(); } }),
  };
}

const ASK_ATTEMPTS = 4;
const ASK_POLLS = 10;
const ASK_POLL_MS = 300;
const SCROLLBACK_WINDOW = 200000;

/**
 * The END of the session's scrollback.
 *
 * `offset` slices FORWARD from the head (server.js: `full.slice(start, start + limit)`),
 * so the obvious `offset=0&limit=N` is the OLDEST N characters, not the newest. Once a
 * session's sanitized scrollback passes N nothing new is ever visible again, and a
 * helper reading it would fail permanently while reporting "the shell never answered".
 * `total` comes back on every response, so the window is anchored on it.
 */
async function scrollbackTail(ctx, id) {
  const head = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=1`)).json();
  const total = Number(head.total) || 0;
  const offset = Math.max(0, total - SCROLLBACK_WINDOW);
  const j = await (await ctx.get(
    `/api/sessions/${id}/scrollback?offset=${offset}&limit=${SCROLLBACK_WINDOW}`,
  )).json();
  return String(j.data || '');
}

/**
 * What the PTY itself believes it is, asked FRESH.
 *
 * Each call stamps its question with a NONCE and accepts only its own answer. Counting
 * markers instead ("more than there were before") cannot attribute one: an echo from a
 * previous call still in flight lands during this one and is read as this one's answer,
 * which is a size sampled before whatever the caller just did. That is harmless where a
 * size must CHANGE — a stale read just costs a retry — but this file's actual regression
 * guard asserts a size did NOT change, and there a stale read is a silent PASS while a
 * last-writer-wins regression is live.
 *
 * ASK AGAIN, don't wait harder. The question is typed into a shell being resized around
 * it, and a keystroke swallowed by readline's SIGWINCH redraw is gone — polling longer
 * can never recover it. Typing once and polling 12s made one lost keystroke an
 * unconditional 12s failure, which is the shape CI kept failing in (red on 5ca146e and
 * f2ed601, green on f7b3550 between them) and which never reproduced locally in 6
 * consecutive runs, because losing that race needs a slower box.
 *
 * Every retry sends ^C FIRST. A swallowed keystroke leaves a PARTIAL line in readline,
 * and appending a second command to it yields `…$(stty sizecho "WTSZ…` — unbalanced
 * quotes, so bash drops to its `>` continuation prompt and every later attempt feeds it
 * more text it can never close. That would wedge the shell for the rest of the test:
 * a retry that assumes a clean line is worse than no retry at all.
 */
async function ptySize(ctx, v, id) {
  const nonce = Math.random().toString(36).slice(2, 8);
  const answer = new RegExp(`WTSZ${nonce}:(\\d+)\\s+(\\d+)`);
  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
    if (attempt > 0) { v.type('\x03'); await sleep(ASK_POLL_MS); }
    v.type(`echo "WTSZ${nonce}:$(stty size)"\r`);
    for (let i = 0; i < ASK_POLLS; i++) {
      await sleep(ASK_POLL_MS);
      const m = answer.exec(await scrollbackTail(ctx, id));
      if (m) return { rows: Number(m[1]), cols: Number(m[2]) };
    }
  }
  // Carry the evidence in the throw. A bare "never answered" cannot distinguish the
  // things that produce it — the shell never ran the command, it ran it and the answer
  // was reflowed into something the regex no longer matches, or the PTY is wedged — and
  // this assertion runs on a CI box nobody can attach a debugger to. Same principle as
  // the WS input drop in server.js: a failure that leaves no trace is unprovable after
  // the fact.
  //
  // Guarded: an expired session, a 500 or a login redirect would make `.json()` reject
  // and replace this message with a JSON parse error — destroying the diagnostic in
  // exactly the cases it exists for.
  let tail = '<scrollback unavailable>';
  try {
    // Escape the whole C0 range, not just ESC: a redraw tail is dense in CR, which
    // would overwrite this message in a CI console and hide the evidence.
    tail = (await scrollbackTail(ctx, id)).slice(-400)
      .replace(/[\x00-\x1f\x7f]/g, (c) => `<${c.charCodeAt(0).toString(16)}>`);
  } catch { /* keep the placeholder — the message matters more than the tail */ }
  throw new Error(
    `the shell never answered with its size (nonce ${nonce}, asked ${ASK_ATTEMPTS}x over `
    + `${(ASK_ATTEMPTS * ASK_POLLS * ASK_POLL_MS) / 1000}s). Scrollback tail:\n${tail}`,
  );
}

/**
 * Poll until the PTY reports [want], and return the last reading either way so the
 * caller's `expect` names the real mismatch.
 *
 * "Eventually" is the honest semantics, not a papered-over race: a viewer's vote
 * reaches the PTY through an async RPC to the worker, so the size is correct SOON
 * after the socket message, never synchronously with it. A rule that had regressed to
 * last-writer-wins would settle on the other size and never match, so this still fails
 * for the reason the test exists.
 */
async function expectPtySize(ctx, v, id, want, tries = 6) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await ptySize(ctx, v, id);
    if (last.cols === want.cols && last.rows === want.rows) return last;
    await sleep(500);
  }
  return last;
}

test('#146: a desktop relayout cannot steal the columns back from a phone', async () => {
  test.slow();
  const ctx = await authCtx();
  const cookie = await rawCookie();
  const cwd = emptyCwd('ptysize');
  let id;
  let desktop, phone;
  try {
    id = (await (await ctx.post('/api/sessions', { data: { name: 'pty-size', cwd } })).json()).id;

    // --- one viewer: it simply owns the size, exactly as before this change.
    desktop = await viewer(cookie, id, 120, 40);
    expect(await expectPtySize(ctx, desktop, id, { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });

    // --- a phone attaches. The PTY must come down to fit it, or every full-width TUI
    //     frame Claude draws will wrap into the phone's 52 columns (#146).
    phone = await viewer(cookie, id, 52, 30);
    expect(await expectPtySize(ctx, phone, id, { cols: 52, rows: 30 })).toEqual({ cols: 52, rows: 30 });

    // --- THE REGRESSION. The desktop relays out and re-states its size, which is what
    //     it does constantly (window resize, sidebar toggle, compose bar growing).
    //     Before this fix that was last-writer-wins and the phone lost its columns here.
    await desktop.setSize(120, 40);
    await sleep(1000);   // give a last-writer-wins regression every chance to show itself
    expect(await ptySize(ctx, phone, id)).toEqual({ cols: 52, rows: 30 });

    // --- the phone backgrounds: it is no longer looking, so it stops voting.
    await phone.background();
    expect(await expectPtySize(ctx, desktop, id, { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });

    // --- and coming back to the phone gives it its fit again, WITHOUT it having to
    //     re-state its size. This is what pins the mode-change recompute: a viewer that
    //     re-activates already has a size on file, and its vote must count again the
    //     moment it does. (Re-sending a resize here would have re-pushed the size all by
    //     itself, so the assertion would have passed with that recompute deleted.)
    phone.ws.send(JSON.stringify({ mode: 'active', browserId: 'phone-again' }));
    await sleep(1200);
    expect(await expectPtySize(ctx, phone, id, { cols: 52, rows: 30 })).toEqual({ cols: 52, rows: 30 });

    // --- the phone leaves entirely: the desktop gets its columns back with no action.
    await phone.close();
    phone = null;
    await sleep(600);
    expect(await expectPtySize(ctx, desktop, id, { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
  } finally {
    if (phone) await phone.close().catch(() => {});
    if (desktop) await desktop.close().catch(() => {});
    if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    await ctx.dispose();
  }
});
