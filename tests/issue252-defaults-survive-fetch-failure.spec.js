// @ts-check
// #252 - "this server lost its default folder and command".
//
// The server was never at fault: GET /api/config fills every default in. What broke was
// the CLIENT rule, and both clients shipped it independently - a failed defaults fetch
// was rendered as "the server has no defaults": empty command box, no folder
// suggestions, nothing said, and no retry. On the web that persisted for the life of the
// page, because init() ran the three raw fetches through Promise.all with no catch, so
// ONE rejection skipped every statement below it.
//
// These assert the RULE, not the mechanism: a fetch failure must never be
// indistinguishable from an empty answer.
//
// NO literal backslash and NO regex escapes anywhere in this file - Windows paths are
// built from BS, and routes are matched with URL predicates. A backslash written through
// an editing channel that collapses "\\" to "\" silently turns these fixtures into
// control characters, which is a recorded trap in this repo.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage, SIGNAL_TIMEOUT_MS } = require('./test-helpers');

// Routes are installed AFTER loginPage() on purpose. It ends on '/', which serves the
// app, so a route installed before it is consumed by the LOGIN navigation's page load and
// the measured goto() then gets a healthy response - which made the first test here pass
// against the unfixed code.

const BS = String.fromCharCode(92);
const ROOT = `C:${BS}test-root`;
const CFG = {
  defaultCwd: ROOT,
  scanFolders: [ROOT],
  defaultCommand: 'TEST-CMD',
  keepSessionsOpen: true,
};

const okJson = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
const isConfig = (url) => url.pathname === '/api/config';
const isHostname = (url) => url.pathname === '/api/hostname';
const isFolders = (url) => url.pathname.endsWith('/history/folders');

// Re-open the new-session form and read its fields. The form fills them from the
// module-scoped defaults AT OPEN TIME, so polling must re-open it rather than watch one
// snapshot - and those are `let` bindings, which are not window properties, so the
// assertion goes through the DOM anyway. That is what the user actually sees.
function reopenAndRead(page) {
  return page.evaluate(() => {
    document.getElementById('newSessionForm').classList.remove('show');
    window.toggleNewForm();
    return {
      cmd: document.getElementById('newCmd').value,
      cwd: document.getElementById('newCwd').value,
    };
  });
}

test.describe('#252: a failed defaults fetch must not read as "no defaults"', () => {
  test('a transient /api/config failure is retried, so the defaults still arrive', async ({ page }) => {
    await loginPage(page);
    let calls = 0;
    await page.route(isConfig, async (route) => {
      calls++;
      if (calls === 1) return route.abort('failed');
      return route.fulfill(okJson(CFG));
    });
    await page.route(isFolders, (r) => r.fulfill(okJson([ROOT])));
    await page.goto(BASE + '/app');

    await expect.poll(async () => (await reopenAndRead(page)).cmd, { timeout: 15000 }).toBe('TEST-CMD');
    expect((await reopenAndRead(page)).cwd).toBe(ROOT + BS);
    expect(calls).toBeGreaterThanOrEqual(2); // it really did retry
  });

  test('a failed /api/hostname does not cost the config defaults', async ({ page }) => {
    // Non-JSON on purpose: r.json() rejects on an HTML error page, which is how a 502
    // from the tailnet proxy or a mid-restart server actually arrives.
    await loginPage(page);
    await page.route(isHostname, (r) =>
      r.fulfill({ status: 500, contentType: 'text/html', body: '<html>bad gateway</html>' }));
    await page.route(isConfig, (r) => r.fulfill(okJson(CFG)));
    await page.route(isFolders, (r) => r.fulfill(okJson([ROOT])));
    await page.goto(BASE + '/app');

    await expect.poll(async () => (await reopenAndRead(page)).cmd, { timeout: 15000 }).toBe('TEST-CMD');
  });

  test('a persistent /api/config failure still loads folders, and SAYS so', async ({ page }) => {
    await loginPage(page);
    await page.route(isConfig, (r) => r.abort('failed'));
    await page.route(isFolders, (r) => r.fulfill(okJson([`C:${BS}aaa`, `C:${BS}bbb`])));
    const configFailed = page.waitForEvent('requestfailed', {
      predicate: (req) => isConfig(new URL(req.url())), timeout: SIGNAL_TIMEOUT_MS,
    });
    await page.goto(BASE + '/app');

    // The folder list does not depend on the config fetch.
    await expect
      .poll(async () => {
        await reopenAndRead(page);
        return page.evaluate(() => {
          // Clear the box first: showFolders() filters BY it, and the fallback cwd would
          // match none of these fixtures - an empty list would then prove nothing.
          document.getElementById('newCwd').value = '';
          window.showFolders();
          return document.querySelectorAll('#folderSuggestions > div').length;
        });
      }, { timeout: 15000 })
      .toBe(2);

    // And the failure is VISIBLE rather than silently-empty fields.
    //
    // #282 - BUT ONLY ONCE THERE HAS BEEN A FAILURE. The CI failure read
    // `<div hidden="" id="newFormNotice"></div>`: hidden AND EMPTY, which is the page's
    // initial markup - not a notice that was shown and lost, but a /api/config request
    // whose abort the page had not yet seen. The folder poll above is no proxy for it:
    // the form fetches its folders on a request of its own. So wait for the page to
    // observe the failure, then ask the question this test is about.
    await configFailed;
    await expect(page.locator('#newFormNotice')).toBeVisible();
  });
});
