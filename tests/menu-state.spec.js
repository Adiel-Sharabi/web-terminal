// @ts-check
// #316 — a Claude session whose composer is covered by a panel or menu (/status,
// /usage, /model, /config, Agent View) must say so: it reads idle, and a prompt sent to
// it goes nowhere. The rule (lib/menu-state.js) is ORDER in the PTY stream: a panel
// footer after the last composer marker means a panel is up; a composer after it means
// the composer is back.
//
// The byte shapes below are the REAL ones, captured with scripts/rig/probe-menu-state.js
// (claude 2.1.29x, 2026-10-07): words positioned with CHA and no literal spaces (#190).
// Built from code points, never typed - see tests/blocking-prompt.spec.js for why. The
// second half drives the real pty-worker.js through __testInjectOutput, the exact path
// term.onData uses.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { connectClient, rpc } = require('./worker-ipc');
const agents = require('../lib/agents');
const { createMenuDetector } = require('../lib/menu-state');
const { sessionReason } = require('../lib/session-reason');

const ESC = String.fromCodePoint(0x001b);
const CARET = String.fromCodePoint(0x276f);
const NBSP = String.fromCodePoint(0x00a0);
const at = (n) => `${ESC}[${n}G`;
const grey = `${ESC}[38;2;153;153;153m`;

const COMPOSER = `${ESC}[38;2;136;136;136m${'-'.repeat(8)}${ESC}[39m\r\n${CARET}${NBSP}\r\n`;
const STATUS_PANEL = `${at(2)}Status${at(9)}Config${at(16)}Usage\r\n\r\n${at(2)}${grey}Esc${at(7)}to${at(10)}cancel${ESC}[39m\r\n`;
const CONFIG_PANEL = `${grey}Enter/↓ to select · ↑ to tabs · Esc to clear${ESC}[39m\r\n`;
const AGENT_VIEW = `${grey} ·${at(27)}enter${at(33)}to${at(36)}return${at(43)}·${ESC}[39m\r\n`;
const SPINNER = `${grey}✳ Thinking… (3s · esc to interrupt)${ESC}[39m\r\n`;

test.describe('#316 the rule: panel footer vs composer, by order', () => {
  const footer = agents.panelFooterMarker('claude');
  const composer = agents.readinessMarker('claude');

  test('the registry declares it for Claude only', () => {
    expect(footer).toBeInstanceOf(RegExp);
    expect(agents.panelFooterMarker('codex')).toBeNull();
    expect(agents.panelFooterMarker(null)).toBeNull();
  });

  test('every measured panel footer matches; the working spinner and near misses do not', () => {
    for (const s of [STATUS_PANEL, CONFIG_PANEL, AGENT_VIEW]) expect(footer.test(s)).toBe(true);
    for (const s of [SPINNER, 'Press Esc again to clear', 'tab to cycle', 'escape to cancel']) expect(footer.test(s)).toBe(false);
  });

  test('open a panel -> in a menu; Esc redraws the composer -> out of it', () => {
    const d = createMenuDetector(composer, footer);
    d.push(COMPOSER, 1000);
    expect(d.inMenu).toBe(false);
    expect(d.push(STATUS_PANEL, 2000)).toBe(true);
    expect(d).toMatchObject({ inMenu: true, since: 2000 });
    expect(d.push(COMPOSER, 3000)).toBe(true);
    expect(d).toMatchObject({ inMenu: false, since: null });
  });

  test('silence changes nothing: an idle TUI writes no bytes', () => {
    const d = createMenuDetector(composer, footer);
    d.push(STATUS_PANEL, 1);
    expect(d.push('', 2)).toBe(false);
    expect(d.push(`${ESC}[?25l${ESC}[?25h`, 3)).toBe(false);
    expect(d.inMenu).toBe(true);
  });

  test('a turn that prints a footer phrase but ends on the composer is not a menu', () => {
    const d = createMenuDetector(composer, footer);
    d.push(`some output quoting ${STATUS_PANEL} in a file\r\n${COMPOSER}`, 1);
    expect(d.inMenu).toBe(false);
  });

  test('a composer marker split INSIDE its UTF-8 bytes across two reads is still seen', () => {
    const d = createMenuDetector(composer, footer);
    d.push(STATUS_PANEL, 1);
    const bytes = Buffer.from(COMPOSER, 'utf8');
    const caretAt = bytes.indexOf(Buffer.from(CARET, 'utf8'));
    d.push(bytes.subarray(0, caretAt + 2), 2);  // two of the caret's three bytes
    d.push(bytes.subarray(caretAt + 2), 3);
    expect(d.inMenu).toBe(false);
  });

  test('reset forgets the verdict', () => {
    const d = createMenuDetector(composer, footer);
    d.push(STATUS_PANEL, 1);
    d.reset();
    expect(d).toMatchObject({ inMenu: false, since: null });
  });

  test('both server shapers pass inMenu on (the field forgotten in one of two shapers, again)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const merge = src.slice(src.indexOf('async function _computeClusterSessions'));
    expect(merge.slice(0, merge.indexOf('result.push(...localShaped)'))).toContain('inMenu: s.inMenu === true');
    const list = src.slice(src.indexOf("app.get('/api/sessions'"));
    expect(list.slice(0, list.indexOf('res.json(shaped)'))).toContain('inMenu: s.inMenu === true');
  });

  test('a footer split across two PTY reads is still seen', () => {
    const d = createMenuDetector(composer, footer);
    d.push(COMPOSER, 1);
    const cut = STATUS_PANEL.indexOf('to');
    d.push(STATUS_PANEL.slice(0, cut), 2);
    expect(d.inMenu).toBe(false);
    d.push(STATUS_PANEL.slice(cut), 3);
    expect(d.inMenu).toBe(true);
  });

  test('the reason: a menu outranks a stale report, but never a running turn, a live prompt or a cap', () => {
    expect(sessionReason({ status: 'idle', inMenu: true, inMenuSince: 7, brief: { wait: { on: 'done', what: 'x' } } }))
      .toMatchObject({ kind: 'menu', source: 'screen', since: 7 });
    // Claude's cap selector prints the same "Esc to cancel": a capped session is capped.
    expect(sessionReason({ status: 'idle', inMenu: true, usageLimit: { waiting: true, armed: true, resetAt: 9 } }).kind).toBe('self');
    expect(sessionReason({ status: 'idle', inMenu: true, usageLimit: { waiting: true, armed: false } })).toBeNull();
    expect(sessionReason({ status: 'working', inMenu: true }).kind).toBe('working');
    expect(sessionReason({ status: 'waiting', waitingFor: 'question', inMenu: true }).kind).toBe('you');
    expect(sessionReason({ status: 'idle', brief: { wait: { on: 'menu' } } })).toBeNull();
  });
});

// --- the real worker ------------------------------------------------------------------

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-worker-test-${crypto.randomUUID()}`
    : `/tmp/wt-worker-test-${crypto.randomUUID()}.sock`;
}

test.describe('#316 the worker publishes inMenu', () => {
  let proc, client, dataDir;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test.beforeEach(async () => {
    const pipePath = workerPipePath();
    dataDir = path.join(os.tmpdir(), 'wt-worker-data-' + crypto.randomUUID());
    fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
      env: { ...process.env, WT_TEST: '1', WT_WORKER_PIPE: pipePath, WT_WORKER_DATA_DIR: dataDir,
        WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1', WT_READY_FALLBACK_MS: '60000' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    client = await connectClient(pipePath);
  });
  test.afterEach(async () => {
    try { client.close(); } catch {}
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', resolve);
      try { proc.kill(); } catch {}
      setTimeout(resolve, 3000);
    });
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  const summary = async (id) => {
    const rows = await rpc(client, 'listSessions');
    return (rows.sessions || rows || []).find((s) => s.id === id);
  };
  const inject = (id, data) => rpc(client, '__testInjectOutput', { id, data });

  test('composer, then a panel, then the composer again', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'menu', agent: 'claude', autoCommand: 'echo probe' });
    await sleep(150);
    expect((await summary(id)).inMenu).toBe(false);

    // The ready latch ignores output until the launch command has been written (#147
    // F3), so feed the composer until the worker has latched.
    await expect.poll(async () => { await inject(id, COMPOSER); return (await summary(id)).agentReady; },
      { timeout: 10_000 }).toBe(true);
    await inject(id, STATUS_PANEL);
    const inside = await summary(id);
    expect(inside.inMenu).toBe(true);
    expect(typeof inside.inMenuSince).toBe('number');

    await inject(id, COMPOSER);
    const out = await summary(id);
    expect(out.inMenu).toBe(false);
    expect(out.inMenuSince).toBeNull();
  });

  test('after the agent EXITS, a shell printing the phrase is not a menu; the agent coming back re-arms it', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'exit', agent: 'claude', autoCommand: 'echo probe' });
    await sleep(150);
    await expect.poll(async () => { await inject(id, COMPOSER); return (await summary(id)).agentReady; },
      { timeout: 10_000 }).toBe(true);
    await inject(id, STATUS_PANEL);
    expect((await summary(id)).inMenu).toBe(true);

    await rpc(client, 'hookEvent', { id, event: 'SessionEnd' });
    expect((await summary(id)).inMenu).toBe(false);
    await inject(id, `$ cat lib/agents.js\r\n${STATUS_PANEL}`);
    expect((await summary(id)).inMenu).toBe(false);

    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
    await inject(id, STATUS_PANEL);
    expect((await summary(id)).inMenu).toBe(true);
  });

  test('a footer BEFORE the composer has latched is the startup dialog, not a menu', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'boot', agent: 'claude', autoCommand: 'echo probe' });
    await sleep(150);
    await inject(id, STATUS_PANEL);
    expect((await summary(id)).inMenu).toBe(false);
  });

  test('a plain shell is never "in a menu", whatever it prints', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'shell' });
    await sleep(150);
    await inject(id, COMPOSER + STATUS_PANEL);
    expect((await summary(id)).inMenu).toBe(false);
  });
});
