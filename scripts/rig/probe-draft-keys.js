#!/usr/bin/env node
'use strict';
// #479 - what do the editing keys do to an UNSENT draft in Claude's composer?
//
// The server must never submit its own prompt on top of a person's unsent draft
// (lib/composer-draft.js reads the keystrokes it forwards). That rule needs to know,
// per key, whether Claude keeps the draft, clears it, or replaces it with something
// else (history). The screen cannot say what was submitted; the UserPromptSubmit hook's
// `prompt` field can. So each case types a draft, presses the keys under test, then
// types a sentinel and Enter, and reads the submitted text off the hook:
//   prompt === sentinel            the keys CLEARED the draft
//   prompt === draft + sentinel    the draft SURVIVED
//   anything else                  printed as-is (e.g. a history recall)
//
// Direct node-pty, no web-terminal server: a scratch cwd UNDER the trusted tree (trust is
// inherited, #190), CLAUDE* and WT_* scrubbed from the child env, its own hook listener.
// Prints only the probe's own texts. Removes its cwd and transcript folder at the end.
//
//   node scripts/rig/probe-draft-keys.js [case...]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { DIRS } = require('../scratch-dirs');
const { readinessMarker } = require('../../lib/agents');
const { claudeProjectDirName } = require('../../lib/transcript');

const ESC = String.fromCharCode(0x1b);
const COMPOSER = readinessMarker('claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRAFT = 'abc';
const SENT = 'reply with only the word OK';

// Each case: the keys pressed after the draft (or with no draft: `draft: ''`), one write each.
const CASES = [
  { name: 'backspace', keys: ['\x7f', '\x7f', '\x7f'] },
  { name: 'ctrl-c', keys: ['\x03'] },
  { name: 'esc', keys: [ESC] },
  { name: 'esc-esc', keys: [ESC, ESC] },
  { name: 'ctrl-u', keys: ['\x15'] },
  { name: 'left-only', keys: [`${ESC}[D`] },
  { name: 'up-empty', draft: '', keys: [`${ESC}[A`] },
  { name: 'up-down-empty', draft: '', keys: [`${ESC}[A`, `${ESC}[B`] },
  { name: 'up-with-draft', keys: [`${ESC}[A`] },
  { name: 'paste', draft: '', keys: [`${ESC}[200~pasted${ESC}[201~`] },
  { name: 'esc-esc-slow', keys: [ESC, { wait: 1800 }, ESC] },
  { name: 'tab-empty', draft: '', keys: ['\t'] },
  { name: 'shift-tab-empty', draft: '', keys: [`${ESC}[Z`, `${ESC}[Z`, `${ESC}[Z`] },
  { name: 'ctrl-w', keys: ['\x17'] },
  { name: 'home-delete', keys: [`${ESC}[H`, `${ESC}[3~`] },
  { name: 'ctrl-a-ctrl-k', keys: ['\x01', '\x0b'] },
  { name: 'pgup-empty', draft: '', keys: [`${ESC}[5~`] },
  { name: 'at-mention-cr', draft: 'see @note', keys: ['\r', { wait: 3000 }] },
  { name: 'lf-newline', keys: ['\n'] },
  { name: 'ctrl-c-working', during: 'write the whole numbers from 1 to 400 separated by single spaces', keys: ['\x03', { wait: 4000 }] },
  { name: 'esc-working', during: 'write the whole numbers from 1 to 400 separated by single spaces', keys: [ESC, { wait: 4000 }] },
  // Pickers that may write text INTO the box (the #479 gate review): read EVERY prompt submitted.
  { name: 'rewind-esc-esc-cr', draft: '', keys: [ESC, ESC, { wait: 1500 }, 'CR', { wait: 2500 }] },
  { name: 'rewind-cmd-cr-cr', draft: '/rewind', keys: ['CR', { wait: 2000 }, 'CR', { wait: 2500 }] },
  { name: 'ctrl-r-cr', draft: '', keys: ['CTRL-R', 'READY', { wait: 1000 }, 'CR', { wait: 2500 }] },
  { name: 'ctrl-r-ctrl-c', draft: '', keys: ['CTRL-R', 'READY', { wait: 1000 }, 'CTRL-C', { wait: 1500 }] },
  { name: 'queued-esc', during: 'write the whole numbers from 1 to 2000 separated by single spaces', keys: ['CR', { wait: 1500 }, ESC, { wait: 4000 }] },
  { name: 'ctrl-w-trailing-spaces', draft: 'abc  ', keys: ['CTRL-W'] },
  { name: 'rewind-esc-esc-up-cr', draft: '', keys: [ESC, ESC, { wait: 1500 }, 'UP', 'UP', 'CR', { wait: 2500 }] },
  { name: 'rewind-cmd-up-cr', draft: '/rewind', keys: ['CR', { wait: 2000 }, 'UP', 'UP', 'CR', { wait: 2500 }] },
  // Does a slash command fire UserPromptSubmit (the trace shows one per submit)?
  { name: 'slash-cost-cr', draft: '/cost', keys: ['CR', { wait: 2500 }, ESC, { wait: 1000 }] },
  { name: 'rewind-cmd-esc', draft: '/rewind', keys: ['CR', { wait: 2000 }, ESC, { wait: 1500 }] },
  { name: 'esc-esc-working', during: 'write the whole numbers from 1 to 5000 separated by single spaces', draft: '', keys: [ESC, ESC, { wait: 2500 }] },
  // An interrupt with an EMPTY box: does Claude put the interrupted prompt back?
  { name: 'esc-working-empty', during: 'write the whole numbers from 1 to 5000 separated by single spaces', draft: '', keys: [ESC, { wait: 2500 }] },
  { name: 'ctrl-c-working-empty', during: 'write the whole numbers from 1 to 5000 separated by single spaces', draft: '', keys: ['CTRL-C', { wait: 2500 }] },
  { name: 'esc-working-late-empty', during: 'write the whole numbers from 1 to 5000 separated by single spaces', after: 8000, draft: '', keys: [ESC, { wait: 2500 }] },
  { name: 'queued-esc-long', during: 'write the whole numbers from 1 to 5000 separated by single spaces', keys: ['CR', { wait: 1000 }, ESC, { wait: 4000 }] },
];
const ONLY = process.argv.slice(2);
const NAMED = { UP: ESC + '[A', CR: String.fromCharCode(13), 'CTRL-R': String.fromCharCode(0x12), 'CTRL-C': String.fromCharCode(3), 'CTRL-W': String.fromCharCode(0x17) };

function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const guess = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(guess)) return guess;
  const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).find((l) => l.trim()).trim();
}

async function main() {
  const root = path.resolve(DIRS.askq);
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, 'draft-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_GIT_BASH_PATH') continue;
    if (/^CLAUDE/i.test(k) || /^WT_/i.test(k)) delete env[k];
  }
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x');
  const events = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { events.push(JSON.parse(body)); } catch { /* not JSON */ }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hook = [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${server.address().port}/hook`, timeout: 10 }] }];
  const settings = path.join(cwd, '.probe-hooks.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: hook, Stop: hook } }));

  let buf = '';
  let exited = false;
  const p = pty.spawn(resolveClaude(), ['--dangerously-skip-permissions', '--model', 'haiku', '--settings', settings],
    { name: 'xterm-256color', cols: 120, rows: 40, cwd, env });
  p.onData((d) => { buf += d; });
  p.onExit(() => { exited = true; });
  const waitFor = async (pred, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return; if (exited) throw new Error(`claude exited waiting for ${what}`); await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const results = [];
  try {
    // ABORT on a setup failure (CLAUDE.md): no composer = no verdict.
    await waitFor(() => COMPOSER.test(buf), 60000, 'the composer');
    await sleep(6000); // past Claude's startup redraws (#404)
    // One plain turn first, so the history-recall cases have something to recall.
    const prime = async (text) => {
      const n = events.length;
      p.write(text); await sleep(400); p.write('\r');
      await waitFor(() => events.slice(n).some((e) => e.hook_event_name === 'Stop'), 90000, 'the Stop');
      await sleep(1500);
      return events.slice(n).find((e) => e.hook_event_name === 'UserPromptSubmit');
    };
    await prime('reply with only the word READY');
    for (const c of CASES) {
      if (ONLY.length && !ONLY.includes(c.name)) continue;
      const draft = c.draft === undefined ? DRAFT : c.draft;
      // `during`: the draft and the keys go in while a turn runs (its prompt submitted first).
      if (c.during) { p.write(c.during); await sleep(400); p.write('\r'); await sleep(c.after || 2500); }
      for (const ch of draft) { p.write(ch); await sleep(60); }
      await sleep(500);
      const n0 = events.length;
      for (const k of c.keys) { if (typeof k === 'object') { await sleep(k.wait); continue; } p.write(NAMED[k] || k); await sleep(700); }
      // A key that itself submitted a turn: let that turn end before the sentinel.
      const open = () => { let o = 0; for (const e of events.slice(n0)) { if (e.hook_event_name === 'UserPromptSubmit') o += 1; else if (e.hook_event_name === 'Stop') o = 0; } return o > 0; };
      if (open()) await waitFor(() => !open(), 90000, 'the picker turn Stop');
      if (exited) throw new Error(`claude exited during ${c.name}`);
      const ups = await prime(SENT);
      const got = ups ? String(ups.prompt) : null;
      const verdict = got === SENT ? 'CLEARED' : got === draft + SENT ? 'SURVIVED' : 'OTHER';
      const all = events.slice(n0).filter((e) => e.hook_event_name === 'UserPromptSubmit').map((e) => String(e.prompt));
      results.push({ case: c.name, verdict, ...(verdict === 'OTHER' ? { prompt: got } : {}), ...(all.length > 1 ? { allPrompts: all } : {}), trace: events.slice(n0).map((e) => e.hook_event_name).join(',') });
      console.log(JSON.stringify(results[results.length - 1]));
    }
  } catch (e) {
    // What the screen showed when it failed (the probe's own scratch session only).
    if (process.env.PROBE_SCREEN) console.error(require('../../lib/ansi').stripAnsi(buf.slice(-6000)).replace(/[ ]{3,}/g, ' ').slice(-2500));
    throw e;
  } finally {
    try { p.kill(); } catch { /* gone */ }
    server.close();
    for (let i = 0; i < 20 && !exited; i++) await sleep(250);
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    const tdir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
    if (path.dirname(tdir) === path.join(os.homedir(), '.claude', 'projects')) {
      try { fs.rmSync(tdir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

main().catch((e) => { console.error(`ABORT: ${e.message}`); process.exit(2); });
