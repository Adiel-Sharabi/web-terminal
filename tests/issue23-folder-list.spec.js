// @ts-check
// Issue #23: folder list is not refreshed for the target server when the user
// opens the new-session form. The dropdown default is "Local", and the folder
// fetch happens BEFORE the dropdown is populated — so suggestions are for the
// wrong server (usually the server the user is currently connected to, not the
// one they picked to start a new session on).
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Issue #23: folder list per target server', () => {
  test('opening the new-session form pre-selects the current session\'s server and fetches folders for it', async ({ page }) => {
    const fetchedUrls = [];
    // Capture every folder-history request and fulfill with a known response so
    // we can assert WHICH server was queried.
    await page.route(/\/(api|cluster\/[^/]+\/api)\/history\/folders$/, async (route, req) => {
      fetchedUrls.push(req.url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
    // Pin /api/cluster/sessions so init() / loadSidebar can't race-overwrite
    // window.clusterServers between our setup and toggleNewForm().
    const FAKE_CLUSTER = {
      sessions: [],
      servers: [
        { url: 'https://xps.example:7681', name: 'XPS', online: true, needsAuth: false },
        { url: 'https://office.example:7681', name: 'Office', online: true, needsAuth: false },
      ],
    };
    await page.route(/\/api\/cluster\/sessions(\?|$)/, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_CLUSTER) });
    });

    await loginPage(page);
    await page.goto(BASE + '/app');

    // Wait for init's loadSidebar to have run at least once — clusterServers
    // is set inside loadSidebar; waiting for it pins state before we set our
    // own values, so the test isn't racing with a startup fetch.
    await page.waitForFunction(
      () => Array.isArray(window.clusterServers) && window.clusterServers.some(s => s.url === 'https://xps.example:7681'),
      null,
      { timeout: 5000 }
    );

    await page.evaluate(() => {
      window.sessionServerUrl = 'https://xps.example:7681';
    });

    // Clear any folder-history requests triggered by the initial page load.
    fetchedUrls.length = 0;

    // Open the new-session form.
    await page.evaluate(() => window.toggleNewForm());

    // Give loadFolderHistory() a tick to complete.
    await page.waitForTimeout(250);

    // 1) The server dropdown should be pre-selected to the current session's server.
    const selectedUrl = await page.locator('#newServer').inputValue();
    expect(selectedUrl).toBe('https://xps.example:7681');

    // 2) loadFolderHistory should have fetched folders for THAT server, not Local.
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain(`/cluster/${encodeURIComponent('https://xps.example:7681')}/api/history/folders`);
  });

  test('changing the server dropdown refetches folders for the newly selected server', async ({ page }) => {
    const fetchedUrls = [];
    await page.route(/\/(api|cluster\/[^/]+\/api)\/history\/folders$/, async (route, req) => {
      fetchedUrls.push(req.url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    const FAKE_CLUSTER = {
      sessions: [],
      servers: [{ url: 'https://xps.example:7681', name: 'XPS', online: true, needsAuth: false }],
    };
    await page.route(/\/api\/cluster\/sessions(\?|$)/, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_CLUSTER) });
    });

    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForFunction(
      () => Array.isArray(window.clusterServers) && window.clusterServers.some(s => s.url === 'https://xps.example:7681'),
      null,
      { timeout: 5000 }
    );
    await page.evaluate(() => {
      window.sessionServerUrl = null; // local
    });

    fetchedUrls.length = 0;
    await page.evaluate(() => window.toggleNewForm());
    await page.waitForTimeout(150);
    const initialCount = fetchedUrls.length;
    expect(initialCount).toBeGreaterThan(0); // Local fetched on open

    // Change the dropdown to the remote server.
    await page.selectOption('#newServer', 'https://xps.example:7681');
    await page.waitForTimeout(150);

    const lastUrl = fetchedUrls[fetchedUrls.length - 1];
    expect(lastUrl).toContain(`/cluster/${encodeURIComponent('https://xps.example:7681')}/api/history/folders`);
  });
});
