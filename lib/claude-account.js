'use strict';
// This machine's Claude Code login, and switching it between saved accounts (#389).
// The one owner of the rule: scripts/claude-account.js (CLI) and the
// /api/claude-account routes (the companion's per-machine "Switch account") both call it.
//
// A login is TWO blocks in two files, and a switch changes those two keys and
// nothing else:
//   ~/.claude/.credentials.json  -> claudeAiOauth   (the same file holds mcpOAuth: never touched)
//   ~/.claude.json               -> oauthAccount    (which account; every per-account cache in
//                                                    that file is keyed by account/org uuid, so
//                                                    the caches of both accounts coexist)
// Claude Code rereads the login from disk, so a RUNNING session follows the swap with
// no restart (measured on Office 2026-10-26: sessions moved both ways, same pids).
// CLAUDE_CODE_OAUTH_TOKEN is the wrong tool: it is fixed when a process starts.
//
// Saved logins live OUTSIDE every repo, in ~/.config/web-terminal/claude-accounts/,
// with an ACL for the current user only. Each machine keeps ITS OWN copy of each
// account: never copy a saved login to another machine - refresh tokens rotate, so
// two machines sharing one would log each other out.
//
// switchTo() always saves the current login first: a running session rotates the
// refresh token as it refreshes, so a copy saved earlier may already be dead.
//
// Nothing here returns or logs a token. Every read refuses (changing nothing) when a
// file is missing, unreadable, not JSON, or not an object - a read-mutate-write over
// `{}` would replace the whole file (#264).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKUPS_KEPT = 20; // per file; one switch writes one of each
const REFRESH_WARN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

class Refusal extends Error {}

function paths(home = os.homedir()) {
  const store = path.join(home, '.config', 'web-terminal', 'claude-accounts');
  return {
    cred: path.join(home, '.claude', '.credentials.json'),
    config: path.join(home, '.claude.json'),
    store,
    backups: path.join(store, 'backups'),
  };
}

// A label is a file name in the store, so it is a closed alphabet: no separators, no `..`,
// and no Windows device name (`NUL.json` is the null device, not a file).
function checkLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9@+_-][A-Za-z0-9@+._-]{0,99}$/.test(label) || label.includes('..') ||
      /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(label)) {
    throw new Refusal(`"${label}" is not a usable label (letters, digits, @ + . _ - only)`);
  }
  return label;
}

function readJsonObject(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Refusal(`cannot read ${what} (${e.code || e.message}); nothing was changed`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(`${what} is not valid JSON; nothing was changed`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Refusal(`${what} is empty or not a JSON object; nothing was changed`);
  }
  return { text, value };
}

// Keep the file's own layout: Claude Code writes .claude.json indented and the
// credentials file compact.
function serialise(value, originalText) {
  const indent = /^\{\s*\n(\s+)"/.exec(originalText);
  const body = indent ? JSON.stringify(value, null, indent[1].length) : JSON.stringify(value);
  return originalText.endsWith('\n') ? body + '\n' : body;
}

// Temp file in the same directory, then rename: a reader sees the old file or the
// new one, never half of either. Windows can refuse a rename while another process
// has the target open; retry a few times, then fail loudly.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 5 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

// The store holds live refresh tokens: only the current user may read it.
function ensureStore(p) {
  const created = !fs.existsSync(p.store);
  fs.mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  if (created && process.platform === 'win32') {
    const user = os.userInfo().username;
    execFileSync('icacls', [p.store, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      windowsHide: true, stdio: 'ignore',
    });
  }
}

function readLogin(p) {
  const cred = readJsonObject(p.cred, '~/.claude/.credentials.json');
  const config = readJsonObject(p.config, '~/.claude.json');
  const oauth = cred.value.claudeAiOauth;
  const account = config.value.oauthAccount;
  return { cred, config, login: oauth && account ? { claudeAiOauth: oauth, oauthAccount: account } : null };
}

function listSaved(p) {
  if (!fs.existsSync(p.store)) return [];
  return fs.readdirSync(p.store)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const label = f.slice(0, -'.json'.length);
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(p.store, f), 'utf8'));
        return saved && saved.claudeAiOauth && saved.oauthAccount ? { label, ...saved } : { label, broken: true };
      } catch {
        return { label, broken: true };
      }
    });
}

// The saved entry for an account is found by its uuid, so a custom label keeps
// receiving fresh saves of that account.
function savedFor(account, saved) {
  return saved.find((s) => !s.broken && s.oauthAccount.accountUuid === account.accountUuid) || null;
}

function saveLogin(p, login, label) {
  ensureStore(p);
  const existing = savedFor(login.oauthAccount, listSaved(p));
  const name = checkLabel(label || (existing && existing.label) || login.oauthAccount.emailAddress);
  const entry = { savedAt: new Date().toISOString(), ...login };
  writeAtomic(path.join(p.store, `${name}.json`), JSON.stringify(entry, null, 2) + '\n');
  if (existing && existing.label !== name) fs.unlinkSync(path.join(p.store, `${existing.label}.json`));
  return name;
}

function backup(p, text, kind, stamp) {
  fs.writeFileSync(path.join(p.backups, `${stamp}-${kind}`), text, { mode: 0o600 });
  const mine = fs.readdirSync(p.backups).filter((f) => f.endsWith(`-${kind}`)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) fs.unlinkSync(path.join(p.backups, old));
}

// What may leave this module about a login: who and until when - never a token.
function describe(oauth, account) {
  const refreshExpiresAt = typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : null;
  return {
    email: account.emailAddress || null,
    organization: account.organizationName || null,
    plan: oauth.subscriptionType || null,
    refreshExpiresAt,
    refreshExpiringSoon: refreshExpiresAt !== null && refreshExpiresAt - Date.now() < REFRESH_WARN_DAYS * DAY_MS,
  };
}

/**
 * The active login and every saved one. `saved[].active` marks the saved copy of
 * the active account; its own numbers are the saved copy's, older than `active`'s.
 */
function status(home) {
  const p = paths(home);
  const { login } = readLogin(p);
  const saved = listSaved(p);
  const activeSaved = login && savedFor(login.oauthAccount, saved);
  return {
    active: login ? { ...describe(login.claudeAiOauth, login.oauthAccount), label: activeSaved ? activeSaved.label : null } : null,
    saved: saved.map((s) => (s.broken
      ? { label: s.label, broken: true }
      : {
        label: s.label,
        savedAt: s.savedAt || null,
        active: !!login && s.oauthAccount.accountUuid === login.oauthAccount.accountUuid,
        ...describe(s.claudeAiOauth, s.oauthAccount),
      })),
  };
}

/** Save the active login under `label` (default: its existing label, else its email). */
function save(label, home) {
  const p = paths(home);
  if (label !== undefined && label !== null) checkLabel(label);
  const { login } = readLogin(p);
  if (!login) throw new Refusal('not logged in: nothing to save');
  return { label: saveLogin(p, login, label || null), email: login.oauthAccount.emailAddress };
}

/**
 * Make the saved account `target` (a label or an email) this machine's login.
 * Returns { from, to, label, alreadyActive }; `from` is null when no one was logged in.
 */
function switchTo(target, home) {
  const p = paths(home);
  if (!target || typeof target !== 'string') throw new Refusal('switch needs a label or email');
  const to = listSaved(p).find((s) => !s.broken && (s.label === target || s.oauthAccount.emailAddress === target));
  if (!to) throw new Refusal(`no saved account "${target}" on this machine`);

  const before = readLogin(p);
  const from = before.login ? before.login.oauthAccount.emailAddress : null;
  if (before.login) {
    saveLogin(p, before.login, null);
    if (before.login.oauthAccount.accountUuid === to.oauthAccount.accountUuid) {
      return { from, to: to.oauthAccount.emailAddress, label: to.label, alreadyActive: true };
    }
  }

  ensureStore(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup(p, before.cred.text, 'credentials.json', stamp);
  backup(p, before.config.text, 'claude.json', stamp);

  // Re-read right before each write: Claude Code rewrites .claude.json constantly,
  // and the window between our read and our rename should be as small as possible.
  const mcpBefore = JSON.stringify(before.cred.value.mcpOAuth);
  const cred = readJsonObject(p.cred, '~/.claude/.credentials.json');
  writeAtomic(p.cred, serialise({ ...cred.value, claudeAiOauth: to.claudeAiOauth }, cred.text));
  const config = readJsonObject(p.config, '~/.claude.json');
  writeAtomic(p.config, serialise({ ...config.value, oauthAccount: to.oauthAccount }, config.text));

  // Prove it: the files now name the target, and the MCP logins are what they were.
  const after = readLogin(p);
  if (!after.login || after.login.oauthAccount.accountUuid !== to.oauthAccount.accountUuid ||
      after.login.claudeAiOauth.refreshToken !== to.claudeAiOauth.refreshToken) {
    throw new Error(`the login files do not name ${to.oauthAccount.emailAddress} after the write; backups are in ${p.backups}`);
  }
  if (JSON.stringify(after.cred.value.mcpOAuth) !== mcpBefore) {
    throw new Error('mcpOAuth changed during the switch - something else wrote the credentials file');
  }
  return { from, to: to.oauthAccount.emailAddress, label: to.label, alreadyActive: false };
}

module.exports = { status, save, switchTo, Refusal, REFRESH_WARN_DAYS };
