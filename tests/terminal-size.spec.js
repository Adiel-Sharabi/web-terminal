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

/**
 * What the PTY itself believes it is. Asks the shell and reads the answer back out of
 * the scrollback — the command's own echo contains the literal `$(stty size)`, so the
 * digits can only come from the shell's reply.
 */
async function ptySize(ctx, v, id) {
  v.type('echo "WTSZ:$(stty size)"\r');
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const j = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=200000`)).json();
    const all = [...String(j.data || '').matchAll(/WTSZ:(\d+)\s+(\d+)/g)];
    if (all.length) {
      const m = all[all.length - 1];
      return { rows: Number(m[1]), cols: Number(m[2]) };
    }
  }
  throw new Error('the shell never answered with its size');
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
    expect(await ptySize(ctx, desktop, id)).toEqual({ cols: 120, rows: 40 });

    // --- a phone attaches. The PTY must come down to fit it, or every full-width TUI
    //     frame Claude draws will wrap into the phone's 52 columns (#146).
    phone = await viewer(cookie, id, 52, 30);
    expect(await ptySize(ctx, phone, id)).toEqual({ cols: 52, rows: 30 });

    // --- THE REGRESSION. The desktop relays out and re-states its size, which is what
    //     it does constantly (window resize, sidebar toggle, compose bar growing).
    //     Before this fix that was last-writer-wins and the phone lost its columns here.
    await desktop.setSize(120, 40);
    expect(await ptySize(ctx, phone, id)).toEqual({ cols: 52, rows: 30 });

    // --- the phone backgrounds: it is no longer looking, so it stops voting.
    await phone.background();
    expect(await ptySize(ctx, desktop, id)).toEqual({ cols: 120, rows: 40 });

    // --- and coming back to the phone gives it its fit again.
    phone.ws.send(JSON.stringify({ mode: 'active', browserId: 'phone-again' }));
    await sleep(400);
    await phone.setSize(52, 30);
    expect(await ptySize(ctx, phone, id)).toEqual({ cols: 52, rows: 30 });

    // --- the phone leaves entirely: the desktop gets its columns back with no action.
    await phone.close();
    phone = null;
    await sleep(600);
    expect(await ptySize(ctx, desktop, id)).toEqual({ cols: 120, rows: 40 });
  } finally {
    if (phone) await phone.close().catch(() => {});
    if (desktop) await desktop.close().catch(() => {});
    if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    await ctx.dispose();
  }
});
