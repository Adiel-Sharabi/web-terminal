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

/** Every `WTSZ:` answer the shell has given so far, oldest first. */
async function sizeMarkers(ctx, id) {
  const j = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=200000`)).json();
  return [...String(j.data || '').matchAll(/WTSZ:(\d+)\s+(\d+)/g)]
    .map((m) => ({ rows: Number(m[1]), cols: Number(m[2]) }));
}

/**
 * What the PTY itself believes it is, asked FRESH.
 *
 * The count is taken before the `echo` and the answer is only accepted once a NEW
 * marker appears. Scanning for "the newest WTSZ: in the scrollback" is not enough:
 * every earlier call leaves one behind, so a shell that has not answered yet hands
 * back the PREVIOUS call's size. That passed locally and failed on a slower CI box,
 * which is the whole signature of a stale read.
 */
async function ptySize(ctx, v, id) {
  const before = (await sizeMarkers(ctx, id)).length;
  // ASK AGAIN, don't just wait harder. The question is asked by typing a line into a
  // shell that is being resized around it — and a keystroke swallowed by readline's
  // SIGWINCH redraw is gone, so no amount of extra polling can recover it. The old
  // helper typed exactly once and then polled for 12s, which meant one lost keystroke
  // was an unconditional 12s failure. That is the shape CI kept failing in
  // (`terminal-size.spec.js` red on 5ca146e and f2ed601, green on f7b3550 between
  // them) and it never reproduced locally in 6 consecutive runs, because losing the
  // race needs a box slower than this one.
  //
  // Re-asking cannot weaken the test: the assertion is on the size the PTY REPORTS,
  // and asking twice cannot change that answer. A rule regressed to last-writer-wins
  // still reports the wrong size and still fails, with the real mismatch named.
  for (let attempt = 0; attempt < 4; attempt++) {
    v.type('echo "WTSZ:$(stty size)"\r');
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const all = await sizeMarkers(ctx, id);
      if (all.length > before) return all[all.length - 1];
    }
  }
  // Carry the evidence in the throw. A bare "never answered" cannot distinguish the
  // three things that produce it — the shell never ran the command, it ran it and the
  // answer was reflowed by a SIGWINCH redraw into something the marker regex no longer
  // matches, or the whole PTY is wedged — and this assertion runs on a CI box nobody
  // can attach a debugger to. Same principle as the WS input drop in server.js: a
  // failure that leaves no trace is unprovable after the fact.
  const j = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=200000`)).json();
  const tail = String(j.data || '').slice(-400).replace(/\x1b/g, '<ESC>');
  throw new Error(
    `the shell never answered with its size (markers before=${before}, `
    + `asked 4x over 12s). Scrollback tail:\n${tail}`,
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
