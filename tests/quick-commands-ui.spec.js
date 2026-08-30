// @ts-check
// #188 — the web client's slash-command button, driven by GET /api/commands.
//
// WHAT THESE TESTS ARE ACTUALLY DEFENDING. The feature is one button, but the rule
// behind it is the one that matters: `lib/commands.js` decides WHICH commands are
// offered, what they are called and in what order, and `app.html` decides nothing.
// The regression this guards is not a crash — it is somebody "simplifying" the
// popup into a hard-coded ['compact','clear','context','usage'] in this file, which
// then silently disagrees with the server table and with the companion.
//
// The first test is the cheapest and the most important: app.html is ONE CLASSIC
// SCRIPT, and a single bad top-level line kills the entire page while a full local
// suite still reports green (CLAUDE.md, the `window.f = () => f()` incident — caught
// only by CI failing 73 specs). So: assert no pageerror BEFORE asserting anything
// about the feature.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');
const commands = require('../lib/commands');

/** Collect every uncaught page error while `fn` runs. */
async function withPageErrors(page, fn) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await fn();
  return errors;
}

test.describe('#188 — the quick-command button in app.html', () => {
  test('the page loads clean and the registry reaches the client', async ({ page }) => {
    const errors = await withPageErrors(page, async () => {
      await loginPage(page);
      await page.goto(BASE + '/');
      await page.waitForLoadState('networkidle');
    });
    expect(errors, 'app.html must raise no uncaught error').toEqual([]);

    // The popup is built from the wire, so its contents ARE the server's table.
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('#cmdMenu button .cmd-name')].map((e) => e.textContent));
    expect(items).toEqual(commands.quickCommands().map((c) => '/' + c.name));
  });

  test('the labels and the destructive marker come from the server, not from this file', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('#cmdMenu button')].map((b) => ({
        label: b.querySelector('span').textContent,
        name: b.querySelector('.cmd-name').textContent,
        danger: b.classList.contains('cmd-danger'),
      })));

    const expected = commands.quickCommands().map((c) => ({
      label: c.label, name: '/' + c.name, danger: !!c.confirm,
    }));
    expect(rendered).toEqual(expected);
    // The destructive one is last and is the only one marked — if this flips, a
    // thumb reaching for the first button can destroy a conversation.
    expect(rendered[rendered.length - 1].name).toBe('/clear');
    expect(rendered.filter((r) => r.danger).map((r) => r.name)).toEqual(['/clear']);
  });

  test('eligibility: agent + ready shows it, a booting agent disables it, a shell hides it', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    // Drive renderComposeCommands directly with synthetic session rows. This is the
    // honest unit under test — the RULE — and it avoids depending on a live agent
    // boot, which would make the assertion about timing instead of about policy.
    const out = await page.evaluate(() => {
      // Pin the identity these rules match against, so the assertions are about
      // the RULE and not about whichever session init() happened to auto-select.
      sessionId = 'test-sess-188';
      sessionServerUrl = null;
      const btn = () => {
        const b = document.getElementById('composeCmdBtn');
        return { display: b.style.display, disabled: b.disabled };
      };
      const render = (row) => {
        // @ts-ignore — a top-level function in a classic script IS global.
        renderComposeCommands({ sessions: [Object.assign({ id: sessionId, serverUrl: '' }, row)] });
        return btn();
      };
      return {
        ready: render({ agent: 'claude', agentReady: true }),
        booting: render({ agent: 'claude', agentReady: false }),
        shell: render({ agent: null, agentReady: true }),
        legacy: render({ agent: 'claude' }),                    // server omits the field
        otherPeer: (() => {
          // @ts-ignore
          renderComposeCommands({ sessions: [{ id: sessionId, serverUrl: 'https://peer', agent: 'claude', agentReady: true }] });
          return btn();
        })(),
      };
    });

    expect(out.ready).toEqual({ display: 'flex', disabled: false });
    // #147 — a prompt sent into a booting agent lands on bash and is gone with no
    // error anywhere. The button must not be pressable before the agent is up.
    expect(out.booting.disabled).toBe(true);
    // A plain shell has no slash commands at all.
    expect(out.shell.display).toBe('none');
    // An older server omits agentReady; a missing field must read as READY, or the
    // button would be dead against every server that has not been upgraded.
    expect(out.legacy).toEqual({ display: 'flex', disabled: false });
    // The sidebar merges every peer's sessions, so an id alone is not an identity
    // across the cluster (#180's rule).
    expect(out.otherPeer.display).toBe('none');
  });

  test('a booting agent cannot open the menu', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');
    const open = await page.evaluate(() => {
      // Pin the identity these rules match against, so the assertions are about
      // the RULE and not about whichever session init() happened to auto-select.
      sessionId = 'test-sess-188';
      sessionServerUrl = null;
      // @ts-ignore
      renderComposeCommands({ sessions: [{ id: sessionId, serverUrl: '', agent: 'claude', agentReady: false }] });
      // @ts-ignore
      toggleCmdMenu();
      return document.getElementById('cmdMenu').classList.contains('cmd-open');
    });
    expect(open).toBe(false);
  });

  test('running a command sends the SAME bytes a typed line would', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    // The measurement behind this feature (scripts/rig/probe-slash-submit.js) proved
    // an atomic `/cmd` + CR runs the command exactly as a typed line does. So the
    // button must add NO byte rule of its own — it goes through
    // buildComposeSubmission like every other submission, and the worker still owns
    // submit TIMING (it splits the trailing CR, #55).
    const sent = await page.evaluate(() => {
      const calls = [];
      // @ts-ignore — capture what reaches the socket without opening one.
      const realSend = window.sendInput;
      // @ts-ignore
      window.sendInput = (d) => calls.push(d);
      // @ts-ignore — bare assignment: `ws` is a top-level `let`, so it is NOT on
      // window and window.ws would be a different, unread property (app.html:881).
      ws = { readyState: 1 };
      // @ts-ignore
      runQuickCommand({ name: 'compact', label: 'Compact' });
      // @ts-ignore
      window.sendInput = realSend;
      return calls;
    });
    expect(sent).toEqual(['/compact\r']);
  });

  test('the destructive command asks first, and a refusal sends NOTHING', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    const clear = commands.quickCommands().find((c) => c.name === 'clear');

    // Dismissed confirm -> nothing goes out. This is the assertion that matters:
    // the cost of a mis-tap is an unrecoverable conversation.
    page.once('dialog', (d) => d.dismiss());
    const refused = await page.evaluate((row) => {
      const calls = [];
      // @ts-ignore
      const real = window.sendInput; window.sendInput = (d) => calls.push(d);
      // @ts-ignore — see above: bare assignment, not window.ws.
      ws = { readyState: 1 };
      // @ts-ignore
      runQuickCommand(row);
      // @ts-ignore
      window.sendInput = real;
      return calls;
    }, clear);
    expect(refused).toEqual([]);

    // Accepted confirm -> it runs.
    page.once('dialog', (d) => d.accept());
    const accepted = await page.evaluate((row) => {
      const calls = [];
      // @ts-ignore
      const real = window.sendInput; window.sendInput = (d) => calls.push(d);
      // @ts-ignore — see above: bare assignment, not window.ws.
      ws = { readyState: 1 };
      // @ts-ignore
      runQuickCommand(row);
      // @ts-ignore
      window.sendInput = real;
      return calls;
    }, clear);
    expect(accepted).toEqual(['/clear\r']);
  });
});

// ---------------------------------------------------------------------------
// The collision the first cut of this feature shipped, found in review.
//
// The live `/` line is ALREADY IN THE PTY: composeStreamLive writes it character
// by character as you type (#55), so with `/co` in the box the terminal holds
// `/co` too. Firing a button then sent `/compact\r` on top of it — submitting
// `/co/compact` into Claude's OPEN FUZZY MENU, which commits the HIGHLIGHTED row.
// So the wrong command runs, or none does, and composeLiveSent is left describing
// a line that no longer exists, desyncing every keystroke after it.
//
// Both assertions matter: the BYTES that go out, and the STATE left behind.
// ---------------------------------------------------------------------------
test.describe('#188 — a button must not append to a half-typed live / line', () => {
  test('the live line is erased first, and live state is dropped', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    const out = await page.evaluate(() => {
      const calls = [];
      // @ts-ignore
      const realSend = window.sendInput;
      // @ts-ignore
      window.sendInput = (d) => calls.push(d);
      // @ts-ignore
      ws = { readyState: 1 };

      // Simulate a user mid-`/co`: the field holds it and the PTY has had it
      // streamed, which is exactly what composeLiveSent records.
      // @ts-ignore
      composeInput.value = '/co';
      // @ts-ignore
      composeLive = true;
      // @ts-ignore
      composeLiveSent = '/co';

      // @ts-ignore
      runQuickCommand({ name: 'compact', label: 'Compact' });

      // @ts-ignore
      window.sendInput = realSend;
      return {
        calls,
        // @ts-ignore
        stillLive: composeLive,
        // @ts-ignore
        liveSent: composeLiveSent,
        // @ts-ignore
        field: composeInput.value,
      };
    });

    // Three backspaces erase `/co` from the PTY, THEN the command goes out alone.
    // The DEL is 0x7f — the same byte composeStreamLive uses for its own diff.
    expect(out.calls).toEqual(['\x7f\x7f\x7f', '/compact\r']);
    // Nothing may still claim a live line: composeLiveSent describing bytes that
    // are no longer in the PTY is what desyncs every later keystroke.
    expect(out.stillLive).toBe(false);
    expect(out.liveSent).toBe('');
    expect(out.field).toBe('');
  });

  test('a REFUSED destructive command leaves the live line untouched', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    const clear = commands.quickCommands().find((c) => c.name === 'clear');
    page.once('dialog', (d) => d.dismiss());

    const out = await page.evaluate((row) => {
      const calls = [];
      // @ts-ignore
      const realSend = window.sendInput;
      // @ts-ignore
      window.sendInput = (d) => calls.push(d);
      // @ts-ignore
      ws = { readyState: 1 };
      // @ts-ignore
      composeInput.value = '/co';
      // @ts-ignore
      composeLive = true;
      // @ts-ignore
      composeLiveSent = '/co';
      // @ts-ignore
      runQuickCommand(row);
      // @ts-ignore
      window.sendInput = realSend;
      // @ts-ignore
      return { calls, stillLive: composeLive, liveSent: composeLiveSent, field: composeInput.value };
    }, clear);

    // Cancelling must cost nothing: no bytes, and the half-typed line survives.
    expect(out.calls).toEqual([]);
    expect(out.stillLive).toBe(true);
    expect(out.liveSent).toBe('/co');
    expect(out.field).toBe('/co');
  });
});
