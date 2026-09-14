// @ts-check
// #263 - `app.html` SUBMITS INTO A BOOTING AGENT. #147's gate was companion-only.
//
// A new session drops the user into the compose bar seconds before `claude` boots. Until
// the agent's composer is up the PTY is still at the SHELL, so a prompt sent in that window
// is handed to bash, runs as a command or does nothing, and is gone with no error anywhere.
// That is #147 - the report that arrived from the phone, the tablet and the Windows desktop
// at once - and `composeSend()` checked exactly one thing, the socket's readyState.
//
// TWO PATHS, NOT ONE, and gating only the first reproduces a known regression. The live
// `/`-line writes bytes to the PTY AS YOU TYPE, so a `/co` typed in the first seconds lands
// on bash's command line and the worker then types `claude --resume ...` onto that same
// line, running `/coclaude --resume ...`, which starts no agent at all. CLAUDE.md records
// that as what happened on the companion when submit alone was gated.
//
// WHAT THIS ASSERTS ON, and why it is not the screen. "Did the words reach the PTY" cannot
// be read off the terminal - a submitted prompt and a typed-but-unsubmitted one look the
// same, which is the whole reason #147 survived so long. So the verdict is taken at the
// client's own input funnel: `sendPtyInput` (#206) is the ONE place a byte reaches the
// socket, and this spy sees every one of them.
//
// AND EVERY NEGATIVE IS ANCHORED ON A POSITIVE. "Nothing was sent" is a VACUOUS assertion
// on its own - it passes just as well on a page that failed to load, a session that was
// never created, or a spy that was never installed (this repo's recorded trap: audit the
// negatives first). Two things stop that here: each "nothing was sent" check is preceded by
// a POSITIVE assertion that the refusal NOTICE appeared, and the same test then forces the
// agent ready and proves THE SAME SPY captures a submission.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BASE, authCtx, loginPage } = require('./test-helpers');

// A PHONE-WIDTH VIEWPORT, load-bearing rather than cosmetic: `composeMode` is
// `isMobile && ...` and `isMobile` ORs in `innerWidth < 600`, so at a desktop width there
// is no compose bar at all and every assertion below would pass vacuously (#55 - visibility
// is not the same question as platform).
test.use({ viewport: { width: 390, height: 844 } });

function freshCwd(tag) {
  const dir = path.join(os.tmpdir(), `wt263-${tag}-` + Date.now());
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

/** Every byte this page hands to the socket, in order. */
async function spyOnPtyInput(page) {
  await page.evaluate(() => {
    window.__wt263sent = [];
    const orig = window.sendPtyInput;
    // `window.f = f` - NEVER `window.f = () => f()`. app.html is ONE CLASSIC SCRIPT, so a
    // top-level `function f(){}` IS `window.f`, and an arrow whose body calls `f()`
    // resolves to itself: infinite recursion on the first call and a dead page. Capturing
    // the original in `orig` first is what makes this wrapper safe.
    window.sendPtyInput = (data) => { window.__wt263sent.push(data); return orig(data); };
  });
}
const sentBy = (page) => page.evaluate(() => window.__wt263sent.slice());
const drain = (page) => page.evaluate(() => { window.__wt263sent.length = 0; });

/** #221's rule: seed the drawer shut BEFORE load, or a click here is a coin toss - at this
 *  width `#sidebar.open` is 100vw and covers the compose bar. Asserted, not assumed. */
async function openSession(page, id, name) {
  await page.addInitScript(() => {
    try { sessionStorage.setItem('sidebarOpen', '0'); } catch { /* private mode */ }
  });
  await page.goto(BASE + '/app/' + id);
  await expect(page.locator('#sessionName')).toContainText(name, { timeout: 10000 });
  await expect(page.locator('#sidebar'),
    'no #sidebar at all - the closed-drawer guard below would pass vacuously').toHaveCount(1);
  await expect(page.locator('#sidebar.open'),
    'the phone-width drawer covers everything this spec clicks (#221)').toHaveCount(0);
  await expect(page.locator('#composeInput')).toBeVisible();
}

test.describe('#263: app.html refuses to submit into an agent that is still starting', () => {
  test('submit and the live /-line are both withheld, and both go through once it is up', async ({ page }) => {
    const ctx = await authCtx();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    let id = null;
    try {
      // A session that declares an agent AND carries an autoCommand is the only shape the
      // worker arms a readiness detector for (pty-worker.js: a session with no autoCommand
      // is a plain shell until you type something, and gating it would block the very
      // submit that launches the agent). `sleep` keeps the shell busy so no prompt glyph is
      // printed that a readiness marker could match by accident.
      const created = await ctx.post('/api/sessions', {
        data: { name: 'wt263 booting', cwd: freshCwd('boot'), agent: 'claude', autoCommand: 'sleep 60' },
      });
      expect(created.ok(), 'the fixture session must be created').toBeTruthy();
      id = (await created.json()).id;

      // THE PRECONDITION, ASSERTED. Without it a green run could equally mean the gate was
      // never exercised because the session was ready all along.
      await expect.poll(async () => {
        const list = await (await ctx.get('/api/sessions')).json();
        const row = list.find((s) => s.id === id);
        return row ? row.agentReady : 'no such session';
      }, { message: 'the fixture must actually report agentReady:false' }).toBe(false);

      await loginPage(page);
      await openSession(page, id, 'wt263 booting');
      await spyOnPtyInput(page);

      // ---- 1. an ordinary prompt is REFUSED, and says so -----------------------------
      const PROMPT = 'wt263 a prompt nobody should lose';
      await page.locator('#composeInput').fill(PROMPT);
      await page.locator('#composeSendBtn').click();

      // The positive half FIRST: the refusal is visible and explains itself. Against the
      // unfixed client this is where the test goes red - there is no notice, because the
      // prompt went to bash.
      const notice = page.locator('#composeNotice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('still starting');

      // ...and now the negative means something: not one byte reached the socket.
      expect(await sentBy(page), 'a refused submit must write NOTHING to the PTY').toEqual([]);
      // The words are still in the box. A refusal that ate them would be worse than the bug.
      await expect(page.locator('#composeInput')).toHaveValue(PROMPT);

      // ---- 2. the live '/'-line is withheld too --------------------------------------
      await page.locator('#composeInput').fill('');
      await page.locator('#composeInput').type('/co', { delay: 20 });
      await expect(page.locator('#composeInput')).toHaveValue('/co');
      expect(await sentBy(page), 'the live /-line must not stream into a booting agent').toEqual([]);
      await expect(page.locator('#composeInput'),
        'and it must not have entered live mode, which would leave a stale projection')
        .not.toHaveClass(/live/);

      // ---- 3. the agent comes up, over the LIVE channel -------------------------------
      // Any hook is proof the agent is up (`markAgentReadyFromActivity`), and the server
      // PUSHES `{type:'agentReady'}` on the notify socket. The notice clearing IS that push
      // arriving - nothing in this client polls readiness.
      const hook = await ctx.post(`/api/session/${id}/hook`, {
        data: { event: 'UserPromptSubmit', session_id: '26326326-0000-0000-0000-000000000001' },
      });
      expect(hook.ok(), 'the hook that forces readiness must be accepted').toBeTruthy();
      await expect(notice, 'the refusal must clear itself when the agent comes up').toBeHidden();

      // ---- 4. THE POSITIVE CONTROL ----------------------------------------------------
      // Same spy, same buttons, an agent that is now ready. If this captures nothing then
      // every `toEqual([])` above proved nothing at all.
      await drain(page);
      await page.locator('#composeInput').fill('');
      await page.locator('#composeInput').type('/co', { delay: 20 });
      await expect.poll(async () => (await sentBy(page)).join(''),
        { message: 'a ready agent must receive the live /-line as it is typed' }).toContain('/co');
      await expect(page.locator('#composeInput'),
        'and NOW it is live, which is the state the booting session must not reach')
        .toHaveClass(/live/);

      await page.locator('#composeInput').fill('');
      await drain(page);
      await page.locator('#composeInput').fill('wt263 now it should land');
      await page.locator('#composeSendBtn').click();
      await expect.poll(async () => (await sentBy(page)).join(''),
        { message: 'a ready agent must receive the submission' }).toContain('wt263 now it should land');

      expect(errors, 'app.html must raise no uncaught error').toEqual([]);
    } finally {
      if (id) { try { await ctx.delete('/api/sessions/' + id); } catch (e) {} }
      await ctx.dispose();
    }
  });

  test('a session with no agent is never gated - a plain shell must stay typable', async ({ page }) => {
    // The failure direction that would be WORSE than the bug: a compose bar refusing to
    // submit on a session with no agent to wait for. `agentReady` defaults to true on the
    // worker, the server and the client, and this pins that the client honours it.
    const ctx = await authCtx();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    let id = null;
    try {
      id = (await (await ctx.post('/api/sessions', {
        data: { name: 'wt263 plain shell', cwd: freshCwd('shell'), autoCommand: '' },
      })).json()).id;

      const list = await (await ctx.get('/api/sessions')).json();
      expect(list.find((s) => s.id === id).agentReady,
        'a plain shell is ready from birth').not.toBe(false);

      await loginPage(page);
      await openSession(page, id, 'wt263 plain shell');
      await spyOnPtyInput(page);

      await page.locator('#composeInput').fill('echo wt263-shell');
      await page.locator('#composeSendBtn').click();
      await expect.poll(async () => (await sentBy(page)).join(''),
        { message: 'a plain shell must never be gated' }).toContain('echo wt263-shell');
      await expect(page.locator('#composeNotice')).toBeHidden();
    } finally {
      if (id) { try { await ctx.delete('/api/sessions/' + id); } catch (e) {} }
      await ctx.dispose();
    }
  });
});
