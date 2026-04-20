// @ts-check
const { request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

/** Read per-process hook token (H1) from .hook-token so tests can hit hook endpoints. */
function readHookToken() {
  try { return fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim(); } catch { return ''; }
}

/** Create a request context with cookie auth */
async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: {
      Cookie: setCookie.split(';')[0],
      'X-WT-Hook-Token': readHookToken(),
    },
  });
}

/** Create a request context without auth */
async function noAuthCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

/** Login via page (for browser-based tests) */
async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

module.exports = { BASE, AUTH, authCtx, noAuthCtx, loginPage, readHookToken };
