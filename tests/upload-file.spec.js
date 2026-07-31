// #90 — POST /api/upload-file, the endpoint behind dropping a file onto the
// compose bar.
//
// The bytes travel on purpose: the agent runs on the SERVER, so the path the
// dropping device sees would name a file the agent cannot open for a remote
// cluster session — and would silently name the WRONG file if a same-named one
// happened to exist there.
//
// The filename arrives in a client-supplied HEADER and is then joined onto a
// server path, so this is a path-traversal surface and most of what follows is
// about that.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE, authCtx, noAuthCtx } = require('./test-helpers');

const DROPPED_DIR = path.join(__dirname, '..', 'dropped-files');

async function upload(ctx, name, body) {
  return ctx.post(`${BASE}/api/upload-file`, {
    headers: { 'content-type': 'application/octet-stream', 'x-filename': name },
    data: body,
  });
}

test.describe('POST /api/upload-file (#90 dropped files)', () => {
  test('requires auth', async () => {
    const ctx = await noAuthCtx();
    const res = await upload(ctx, 'x.txt', Buffer.from('hello'));
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('stores the bytes and returns the server-side path', async () => {
    const ctx = await authCtx();
    const body = Buffer.from('dropped file contents');
    const res = await upload(ctx, 'notes.txt', body);
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(fs.readFileSync(json.path)).toEqual(body);
    // The agent is handed this path, so it must be absolute.
    expect(path.isAbsolute(json.path)).toBe(true);
    fs.unlinkSync(json.path);
    await ctx.dispose();
  });

  test('a traversing filename cannot escape the drop directory', async () => {
    const ctx = await authCtx();
    const nasty = [
      '../../evil.txt',
      '..\\..\\evil.txt',
      'C:\\Windows\\System32\\evil.txt',
      '/etc/passwd',
      '....//....//evil.txt',
    ];
    for (const name of nasty) {
      const res = await upload(ctx, name, Buffer.from('x'));
      expect(res.ok()).toBeTruthy();
      const { path: p } = await res.json();
      // Resolved, the file must still sit directly inside dropped-files.
      expect(path.dirname(path.resolve(p))).toBe(path.resolve(DROPPED_DIR));
      fs.unlinkSync(p);
    }
    await ctx.dispose();
  });

  test('cannot create a hidden dotfile, and always yields a usable name', async () => {
    const ctx = await authCtx();
    for (const name of ['.bashrc', '...', '', '???']) {
      const res = await upload(ctx, name, Buffer.from('x'));
      expect(res.ok()).toBeTruthy();
      const { path: p } = await res.json();
      const base = path.basename(p);
      // `<timestamp>-<name>`; the name part must be non-empty and not hidden.
      const namePart = base.slice(base.indexOf('-') + 1);
      expect(namePart.length).toBeGreaterThan(0);
      expect(namePart.startsWith('.')).toBe(false);
      fs.unlinkSync(p);
    }
    await ctx.dispose();
  });

  test('two drops of the SAME name do not clobber each other', async () => {
    const ctx = await authCtx();
    const a = await upload(ctx, 'same.txt', Buffer.from('first'));
    const b = await upload(ctx, 'same.txt', Buffer.from('second'));
    const pa = (await a.json()).path;
    const pb = (await b.json()).path;
    expect(pa).not.toBe(pb);
    expect(fs.readFileSync(pa).toString()).toBe('first');
    expect(fs.readFileSync(pb).toString()).toBe('second');
    fs.unlinkSync(pa); fs.unlinkSync(pb);
    await ctx.dispose();
  });

  test('an empty body is rejected', async () => {
    const ctx = await authCtx();
    const res = await upload(ctx, 'empty.txt', Buffer.from(''));
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });
});
