// @ts-check
// A session's cwd is canonicalised on the way in (`POST /api/sessions`).
//
// Why this matters at all: `claudeProjectDirName` (lib/transcript.js) turns a cwd
// into a directory name by replacing every non-alphanumeric char with its own
// dash, uncollapsed. `C:\dev\proj\` therefore encodes one dash longer than
// `C:\dev\proj`, naming a project dir the Claude CLI never creates — so the Chat
// lens silently finds nothing. It is invisible: the session runs fine, the
// terminal works, only the transcript is missing.
//
// The rule is server-side ON PURPOSE. Both clients now pre-fill the folder field
// with a trailing separator so a subfolder can be typed straight away, and a user
// could always type one by hand — normalising in each client would be the same
// rule written twice, with the hand-typed case still broken.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { normalizeCwd } = require('../lib/cwd');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

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
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

test.describe('normalizeCwd — the pure rule', () => {
  test('strips a trailing separator, windows or posix', () => {
    expect(normalizeCwd('C:\\dev\\proj\\')).toBe('C:\\dev\\proj');
    expect(normalizeCwd('/home/user/proj/')).toBe('/home/user/proj');
    expect(normalizeCwd('C:\\dev\\proj')).toBe('C:\\dev\\proj');
  });

  test('collapses a run of trailing separators', () => {
    expect(normalizeCwd('C:\\dev\\proj\\\\')).toBe('C:\\dev\\proj');
    expect(normalizeCwd('/home/proj///')).toBe('/home/proj');
  });

  test('a root keeps its separator — there the separator IS the directory', () => {
    // Bare `C:` is drive-RELATIVE on Windows, not the drive root, and `/` would
    // normalise to nothing at all.
    expect(normalizeCwd('C:\\')).toBe('C:\\');
    expect(normalizeCwd('C:/')).toBe('C:/');
    expect(normalizeCwd('/')).toBe('/');
  });

  test('empty and absent inputs do not throw', () => {
    expect(normalizeCwd('')).toBe('');
    expect(normalizeCwd(null)).toBe('');
    expect(normalizeCwd(undefined)).toBe('');
  });

  test('interior separators are untouched — only the tail is', () => {
    expect(normalizeCwd('C:\\dev\\a b\\c-d\\')).toBe('C:\\dev\\a b\\c-d');
  });
});

test.describe('POST /api/sessions canonicalises cwd', () => {
  let ctx;
  const created = [];
  let dir;

  test.beforeAll(async () => {
    ctx = await authCtx();
    dir = path.join(process.cwd(), 'test-cwd-normalize');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  test.afterAll(async () => {
    for (const id of created) {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
    }
    await ctx.dispose();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('a cwd sent with a trailing slash is stored without one', async () => {
    const res = await ctx.post('/api/sessions', {
      data: { name: `CwdSlash-${Date.now()}`, cwd: dir + path.sep },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    created.push(body.id);

    const list = await (await ctx.get('/api/sessions')).json();
    const s = list.find(x => x.id === body.id);
    // Without the fix this is `...\test-cwd-normalize\`, which encodes to a
    // project-dir name one dash too long and loses the transcript.
    expect(s.cwd).toBe(dir);
  });

  test('a cwd with no trailing slash is left exactly as it was', async () => {
    const res = await ctx.post('/api/sessions', {
      data: { name: `CwdPlain-${Date.now()}`, cwd: dir },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    created.push(body.id);

    const list = await (await ctx.get('/api/sessions')).json();
    expect(list.find(x => x.id === body.id).cwd).toBe(dir);
  });

  test('a trailing-slash cwd still validates — it is not read as missing',
    async () => {
      // The existence check runs on the canonical string, so a real folder given
      // with a trailing separator must not 400 as "Folder does not exist".
      const res = await ctx.post('/api/sessions', {
        data: { name: `CwdExists-${Date.now()}`, cwd: dir + path.sep },
      });
      expect(res.status()).toBe(200);
      created.push((await res.json()).id);
    });
});
