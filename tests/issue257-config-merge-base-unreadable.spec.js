// @ts-check
// #257 — A MERGE NEEDS A BASE IT ACTUALLY READ.
//
// #242 made `PUT /api/config` merge over what is on disk, so a Save can no longer delete
// a key the dialog does not render. The merge base is `readConfig()`, and `readConfig()`
// answered `{}` for TWO different situations:
//
//   * config.json is not there          — a legitimate first run, `{}` is correct;
//   * config.json is there and will not parse — truncated, half-written, mid-edit.
//
// In the second case `Object.assign({}, sanitized)` wrote a file holding only the keys
// the request body carried: the exact pre-#242 REPLACE, silently, at the moment `cluster`
// and `publicUrl` most needed preserving. Both paths answered 200, so no caller could
// tell the difference — which is why this is asserted on the OUTCOME (what is on disk
// afterwards) and not only on the status code.
//
// This was never a #242 regression. It is master's behaviour, and it is filed because
// #242 changed what the code PROMISES and this is the one path where the promise did not
// hold.
//
// THE TRAP IN THE OBVIOUS FIX is the second test. Refusing whenever the merge base is
// empty would also refuse the first Save this server ever makes, which is the ordinary
// state of a fresh checkout and of every CI run. The distinction has to be ABSENT versus
// UNREADABLE, never "is the object empty" — so both directions are pinned here.
//
// CLEANUP. `config.test.json` is this run's config file. The describe restores whatever
// it found, and the second test deliberately re-sends the server's CURRENT serverName so
// that even the `writeConfig` cache it leaves behind carries the right value: with the
// file absent, `_refreshLiveConfig` skips it and pins that cache for the rest of the run,
// which is #240's mechanism and not something to re-create while fixing another bug.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx } = require('./test-helpers');

const CONFIG_FILE = path.join(__dirname, '..', 'config.test.json');

// A merge base that will not parse, carrying two keys NEITHER settings dialog renders.
// Truncated mid-string, which is what a half-written or interrupted write leaves behind.
const CORRUPT = '{"serverName":"wt257-base","cluster":[{"name":"wt257-peer",'
  + '"url":"http://127.0.0.1:1"}],"publicUrl":"http://127.0.0.1:176';

test.describe('#257: PUT /api/config never replaces a merge base it could not read', () => {
  let ctx;
  let saved = null;          // the file's original bytes, or null if it was absent

  test.beforeAll(async () => {
    ctx = await authCtx();
    try { saved = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { saved = null; }
  });

  test.afterAll(async () => {
    try {
      if (saved === null) fs.unlinkSync(CONFIG_FILE);
      else fs.writeFileSync(CONFIG_FILE, saved, 'utf8');
    } catch (e) { /* best effort — the next run deletes this file anyway (#240) */ }
    await ctx.dispose();
  });

  test('an UNREADABLE merge base is refused, and the file is left exactly as it was', async () => {
    // The fixture has to actually be unparseable, or the whole test is about nothing.
    let parsed = true;
    try { JSON.parse(CORRUPT); } catch (e) { parsed = false; }
    expect(parsed, 'the CORRUPT fixture must not parse or this test proves nothing').toBe(false);

    fs.writeFileSync(CONFIG_FILE, CORRUPT, 'utf8');

    // A partial body, exactly the shape every real Save has: a handful of the keys the
    // dialog renders, and nothing about cluster or publicUrl.
    const res = await ctx.put('/api/config', { data: { serverName: 'wt257-changed' } });

    // THE STATUS. 200 was the old answer and it was the misleading half — a client
    // showed "Saved. Changes are live." over a file that had just lost the cluster.
    expect(res.status(), 'a PUT with an unreadable merge base must not report success')
      .toBe(500);

    // THE OUTCOME, which is the assertion that actually distinguishes the two
    // behaviours: under the old code this file now reads
    // `{"serverName":"wt257-changed","password":"..."}`.
    const after = fs.readFileSync(CONFIG_FILE, 'utf8');
    expect(after, 'a refused PUT must not write the file at all').toBe(CORRUPT);
    expect(after).toContain('wt257-peer');
    expect(after).toContain('publicUrl');
  });

  test('an ABSENT config.json still accepts a write — the trap in the obvious fix', async () => {
    // Read the running name first, so the file this test creates (and the live-config
    // cache `writeConfig` fills from it) carries the value the rest of the run expects.
    const served = await (await ctx.get('/api/config')).json();
    const name = served.serverName;
    expect(typeof name, 'GET /api/config must serve a serverName').toBe('string');

    try { fs.unlinkSync(CONFIG_FILE); } catch (e) {}
    expect(fs.existsSync(CONFIG_FILE),
      'the file must really be gone or this test proves nothing').toBe(false);

    const res = await ctx.put('/api/config', { data: { serverName: name } });
    expect(res.status(), 'a first run has no config.json and must still be able to save')
      .toBe(200);

    // The outcome again: the write landed. A fix that tested for an empty merge base
    // instead of an unreadable one would have refused here and left no file.
    expect(fs.existsSync(CONFIG_FILE), 'the first save must create the file').toBe(true);
    expect(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).serverName).toBe(name);
  });
});
