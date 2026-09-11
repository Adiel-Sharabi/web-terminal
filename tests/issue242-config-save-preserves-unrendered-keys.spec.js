// @ts-check
// #242 - Saving Settings must not change a key the dialog does not show.
//
// `PUT /api/config` used to REPLACE the file with exactly the allowlisted keys present
// in the body, and neither settings client round-trips the config it loaded: both build
// a FRESH object from their form fields. `/lobby` sends 10 of the 18 allowed keys and
// `/app` sends 14, so every Save silently deleted the rest - and one Save from `/lobby`
// erased `cluster` and `publicUrl`, collapsing the server's peer list to a single node.
//
// The fix picked ONE owner (the issue's first done-when) and it is the server: the PUT
// merges over what is on disk. So these tests are about the SERVER's promise, and they
// deliberately come in two layers:
//
//   * the API layer pins the mechanism with the clients' EXACT request bodies, so a
//     future client that sends even less is still covered;
//   * the UI layer drives the real dialogs, because the issue's done-when is "Save from
//     both /app and /lobby" and a reconstructed body is a claim about a client, not a
//     reading of one.
//
// WHY EACH IS RED WITHOUT THE FIX: under a replace, a key absent from the request body
// is absent from the file afterwards, and `GET /api/config` then either omits it
// (`exclusiveViewer`, which the GET handler does NOT fill in) or answers with the
// synthesized default (`cluster: []`, `publicUrl: ''`, `openInNewTab: true`). Every
// assertion below is on a value that DIFFERS from what the post-replace read would give,
// which is what keeps them from being vacuous - an assertion of `cluster: []` or
// `autoResumeOnReset: true` would pass against the unfixed server, because those are
// exactly the fill-ins a dropped key produces.
//
// CLEANUP MATTERS MORE NOW, and that is a direct consequence of the fix. Before #242 a
// later partial PUT wiped whatever a spec left behind; under a merge, anything written
// here persists for the rest of the run. Every test restores what it seeded, and the
// describe restores the whole file at the end. The backstop is #240's: `config.test.json`
// is deleted at the start of every run, so nothing here can outlive one run even if the
// suite is interrupted.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE, authCtx, loginPage } = require('./test-helpers');

const CONFIG_FILE = path.join(__dirname, '..', 'config.test.json');

// A peer that can never be reached and can never be slow: port 1 refuses instantly, so
// no fan-out anywhere in the suite can block on it. `/lobby` never calls a cluster route
// at all (it only fetches /api/sessions), and the /app test below clears this first.
const PROBE_PEER = { name: 'wt242-probe', url: 'http://127.0.0.1:1' };
const PROBE_PUBLIC_URL = 'http://127.0.0.1:17681';

const getConfig = async (ctx) => (await ctx.get('/api/config')).json();

// The body `lobby.html` saveSettings() actually sends - 10 keys (lobby.html ~:489).
// Values are taken from what the server just served, so the PUT changes nothing except
// by omission, which is the whole point.
function lobbyBody(served) {
  return {
    serverName: served.serverName,
    port: served.port,
    user: served.user,
    password: served.password,        // '***' - the masked round-trip
    shell: served.shell,
    defaultCwd: served.defaultCwd,
    scanFolders: served.scanFolders,
    defaultCommand: served.defaultCommand,
    scrollbackReplayLimit: served.scrollbackReplayLimit,
    openInNewTab: served.openInNewTab,
  };
}

// The body `app.html` saveSettings() actually sends - FOURTEEN keys (app.html ~:5134).
// The issue says 15; counted against the source it is 14, because `host` is dropped too
// and no dialog on either page renders it.
function appBody(served) {
  return {
    serverName: served.serverName,
    port: served.port,
    user: served.user,
    password: served.password,
    shell: served.shell,
    defaultCwd: served.defaultCwd,
    scanFolders: served.scanFolders,
    defaultCommand: served.defaultCommand,
    scrollbackReplayLimit: served.scrollbackReplayLimit,
    claudeHome: served.claudeHome,
    publicUrl: served.publicUrl,
    keepSessionsOpen: served.keepSessionsOpen,
    autoContinueOnApiError: served.autoContinueOnApiError,
    cluster: served.cluster,
  };
}

test.describe('#242: a Save cannot discard a key the dialog does not render', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await authCtx();
  });

  test.afterAll(async () => {
    // Put the file back to the neutral state the rest of the run expects: no peers, no
    // publicUrl, the defaults for the three booleans, and no non-allowlisted key.
    try {
      const served = await getConfig(ctx);
      served.cluster = [];
      served.publicUrl = '';
      served.openInNewTab = true;
      served.exclusiveViewer = false;
      served.autoResumeOnReset = true;
      await ctx.put('/api/config', { data: served });
      // `enableRemoteExec` cannot be removed through the API by design (the merge
      // preserves it and the allowlist refuses to set it), so the one key this spec
      // wrote directly is removed directly.
      const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      delete onDisk.enableRemoteExec;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
    } catch (e) { /* best effort - the next run deletes this file anyway (#240) */ }
    await ctx.dispose();
  });

  // --- the API layer: the clients' exact bodies -------------------------------

  test('the /lobby body (10 of 18 keys) leaves cluster and publicUrl intact', async () => {
    // Seed through the API, so the seed itself proves nothing about the fix.
    const seed = await getConfig(ctx);
    seed.cluster = [PROBE_PEER];
    seed.publicUrl = PROBE_PUBLIC_URL;
    expect((await ctx.put('/api/config', { data: seed })).status()).toBe(200);
    expect((await getConfig(ctx)).cluster).toEqual([PROBE_PEER]);

    const served = await getConfig(ctx);
    expect((await ctx.put('/api/config', { data: lobbyBody(served) })).status()).toBe(200);

    const after = await getConfig(ctx);
    // Under a replace these read `[]` and `''` - the GET handler's fill-ins for a key
    // that is no longer in the file.
    expect(after.cluster, 'a lobby Save erased the peer list').toEqual([PROBE_PEER]);
    expect(after.publicUrl, 'a lobby Save erased publicUrl').toBe(PROBE_PUBLIC_URL);

    // ...and the eight other keys lobby does not render.
    expect(after.claudeHome).toBe(served.claudeHome);
    expect(after.keepSessionsOpen).toBe(served.keepSessionsOpen);
    expect(after.autoContinueOnApiError).toBe(served.autoContinueOnApiError);

    // Restore before the next test so each one seeds its own state.
    const restore = await getConfig(ctx);
    restore.cluster = [];
    restore.publicUrl = '';
    expect((await ctx.put('/api/config', { data: restore })).status()).toBe(200);
  });

  test('the /app body (14 of 18 keys) leaves autoResumeOnReset, openInNewTab and exclusiveViewer intact', async () => {
    // All three are seeded to the value the post-replace read would NOT give:
    // `autoResumeOnReset` and `openInNewTab` are filled in as `true` when absent, and
    // `exclusiveViewer` is not filled in at all, so it reads `undefined`.
    const seed = await getConfig(ctx);
    seed.autoResumeOnReset = false;
    seed.openInNewTab = false;
    seed.exclusiveViewer = false;
    expect((await ctx.put('/api/config', { data: seed })).status()).toBe(200);

    const served = await getConfig(ctx);
    expect(served.autoResumeOnReset).toBe(false);
    expect(served.exclusiveViewer).toBe(false);

    expect((await ctx.put('/api/config', { data: appBody(served) })).status()).toBe(200);

    const after = await getConfig(ctx);
    expect(after.autoResumeOnReset, 'an app Save re-enabled 5h auto-resume').toBe(false);
    expect(after.openInNewTab, 'an app Save erased openInNewTab').toBe(false);
    expect(after.exclusiveViewer, 'an app Save erased the #21 opt-in').toBe(false);

    const restore = await getConfig(ctx);
    restore.autoResumeOnReset = true;
    restore.openInNewTab = true;
    expect((await ctx.put('/api/config', { data: restore })).status()).toBe(200);
  });

  // --- the third class: keys GET serves that the allowlist cannot carry --------

  test('a key outside ALLOWED_CONFIG_KEYS survives a Save, and still cannot be SET by one', async () => {
    // `enableRemoteExec` is the real case from the issue: it is in this machine's
    // config.json, `GET /api/config` serves it (it copies the whole file), and the PUT
    // allowlist does not carry it - so every Save disabled cluster /api/exec.
    //
    // Seeded to `false`, which is the value that cannot change any behaviour: the flag
    // is read once at startup into `_execEnabled`, and `false` is what the shipped
    // config.default.json carries. Preservation is observable either way, because a
    // dropped key is absent from the GET entirely.
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    onDisk.enableRemoteExec = false;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
    expect((await getConfig(ctx)).enableRemoteExec).toBe(false);

    const served = await getConfig(ctx);
    expect((await ctx.put('/api/config', { data: lobbyBody(served) })).status()).toBe(200);
    expect(
      (await getConfig(ctx)).enableRemoteExec,
      'a Save silently disabled cluster /api/exec on this server',
    ).toBe(false);

    // The other half of the decision, and the reason the allowlist was NOT widened to
    // cover this key: preserving it must not make it settable. An authenticated PUT
    // asking to turn on remote command execution is still refused.
    expect((await ctx.put('/api/config', {
      data: Object.assign(lobbyBody(served), { enableRemoteExec: true }),
    })).status()).toBe(200);
    expect(
      (await getConfig(ctx)).enableRemoteExec,
      'PUT /api/config must never be able to ENABLE remote exec',
    ).toBe(false);
  });

  // --- the UI layer: the real dialogs, driven ---------------------------------

  test('Save in the real /lobby Settings dialog keeps the cluster', async ({ page }) => {
    const seed = await getConfig(ctx);
    seed.cluster = [PROBE_PEER];
    seed.publicUrl = PROBE_PUBLIC_URL;
    expect((await ctx.put('/api/config', { data: seed })).status()).toBe(200);

    await loginPage(page);
    await page.goto(`${BASE}/lobby`);
    // openSettings() and saveSettings() are top-level declarations in a classic script,
    // so they are already globals (the Save button's own onclick calls them by bare
    // name). Waiting on a CONDITION, not a timer.
    await page.waitForFunction(() => typeof window.openSettings === 'function'
      && typeof window.saveSettings === 'function');
    await page.evaluate(async () => { await window.openSettings(); });
    await expect(page.locator('#settingsOverlay')).toHaveClass(/show/);
    await page.evaluate(async () => { await window.saveSettings(); });
    await expect(page.locator('#saveMsg')).toContainText('Saved');

    const after = await getConfig(ctx);
    expect(after.cluster, 'a real /lobby Save erased the peer list').toEqual([PROBE_PEER]);
    expect(after.publicUrl).toBe(PROBE_PUBLIC_URL);

    const restore = await getConfig(ctx);
    restore.cluster = [];
    restore.publicUrl = '';
    expect((await ctx.put('/api/config', { data: restore })).status()).toBe(200);
  });

  test('Save in the real /app Settings dialog keeps exclusiveViewer and openInNewTab', async ({ page }) => {
    // `cluster` stays empty here: /app DOES render a cluster editor, so it is not one of
    // the keys this dialog drops - and an empty list keeps the page's own
    // /api/cluster/sessions call from reaching anything.
    const seed = await getConfig(ctx);
    seed.cluster = [];
    seed.exclusiveViewer = false;
    seed.openInNewTab = false;
    expect((await ctx.put('/api/config', { data: seed })).status()).toBe(200);

    await loginPage(page);
    // A condition, not a timer: both pages are one classic script, so the top-level
    // declarations ARE window properties as soon as it parses.
    await page.waitForFunction(() => typeof window.openSettings === 'function'
      && typeof window.saveSettings === 'function');
    await page.evaluate(async () => { await window.openSettings(); });
    await expect(page.locator('#settingsOverlay')).toHaveClass(/show/);
    await page.evaluate(async () => { await window.saveSettings(); });
    await expect(page.locator('#saveMsg')).toContainText('Saved');

    const after = await getConfig(ctx);
    expect(after.exclusiveViewer, 'a real /app Save erased the #21 opt-in').toBe(false);
    expect(after.openInNewTab, 'a real /app Save erased openInNewTab').toBe(false);

    const restore = await getConfig(ctx);
    restore.openInNewTab = true;
    expect((await ctx.put('/api/config', { data: restore })).status()).toBe(200);
  });
});
