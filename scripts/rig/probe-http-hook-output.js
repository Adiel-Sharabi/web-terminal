#!/usr/bin/env node
'use strict';
// Does Claude Code act on the BODY an http hook answers with? (#298)
//
// The sessions dashboard asks the agent to report what it is working on. The
// instruction reaches the agent through web-terminal's own hook endpoint: the
// SessionStart and UserPromptSubmit answers carry `hookSpecificOutput.additionalContext`,
// and a Stop answer may carry `decision: "block"` when work-item state changed and the
// agent has not reported it. All of that is only true if an HTTP hook's response body is
// read the way a command hook's stdout JSON is — and if the extra keys web-terminal
// already returns (`ok`, `status`) do not make Claude reject the body. Docs are not
// evidence; this measures it against the installed claude.
//
// Three codewords, one per mechanism, each random per run so an answer cannot come from
// anywhere but the hook:
//   SessionStart      additionalContext  -> the session codeword
//   UserPromptSubmit  additionalContext  -> the prompt codeword
//   Stop              decision: block    -> the agent must append the stop codeword
//
// MEASURED 2026-10-06, claude 2.1.291, three runs:
//   UserPromptSubmit additionalContext  HONOURED  (the agent quoted the codeword; it also
//                                       volunteered to the user that a hook added it, so an
//                                       injected note must say it is automatic)
//   Stop decision:block                 HONOURED  (the agent appended the word; the second
//                                       Stop carried stop_hook_active:true, so a block can
//                                       never loop when the server checks that flag)
//   SessionStart                        NEVER DELIVERED to an http hook in `-p` mode — the
//                                       event list was UserPromptSubmit, Stop, Stop. Do not
//                                       build on SessionStart; UserPromptSubmit carries it.
//   web-terminal's own `ok`/`status` keys beside the hook fields void nothing.
//
// ISOLATION (same rules as probe-exit-flush.js, read its header for the why):
//   * CLAUDE_CONFIG_DIR is a throwaway tree whose settings.json registers http hooks
//     pointing at a server THIS SCRIPT runs on an ephemeral port — production's
//     127.0.0.1:7681 never sees an event.
//   * every CLAUDE*, WT_* and ANTHROPIC* variable is stripped from the child env.
//   * `.credentials.json` is COPIED in, only when the access token has
//     --min-token-life minutes left (default 30), and the copy is shredded on every exit
//     path including SIGINT.
//
//   node scripts/rig/probe-http-hook-output.js [--keep] [--min-token-life 30]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { PARENT } = require('../scratch-dirs');

const PROBE_DIR = process.env.WT_HOOK_OUTPUT_PROBE_DIR || path.join(PARENT, 'wt-hook-output-probe');
const REAL_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const liveCopies = new Set();

function shred(p) {
  try {
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, Buffer.alloc(fs.statSync(p).size, 0x30));
      fs.rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
  liveCopies.delete(p);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const p of [...liveCopies]) shred(p); process.exit(130); });
}

function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  return { keep: argv.includes('--keep'), minTokenLife: parseInt(get('--min-token-life', '30'), 10) };
}

function scrubbedEnv(cfgDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|WT_|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = cfgDir;
  return env;
}

function startHookServer(words) {
  const events = [];
  let stops = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as empty */ }
      const ev = body.hook_event_name || '(none)';
      events.push({ ev, stop_hook_active: body.stop_hook_active });
      // Every answer carries web-terminal's own keys too — the real endpoint returns
      // `{ ok, status }` and the probe must show those do not void the rest.
      let out = { ok: true, status: 'unchanged' };
      if (ev === 'SessionStart') {
        out.hookSpecificOutput = { hookEventName: 'SessionStart',
          additionalContext: `The session codeword is ${words.session}.` };
      } else if (ev === 'UserPromptSubmit') {
        out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit',
          additionalContext: `The prompt codeword is ${words.prompt}.` };
      } else if (ev === 'Stop') {
        stops += 1;
        if (!body.stop_hook_active) {
          out = { ...out, decision: 'block',
            reason: `Before finishing, write the word ${words.stop} on its own final line.` };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, port: server.address().port, events, stopCount: () => stops })));
}

function seedConfig(cfgDir, cwd, port) {
  fs.mkdirSync(cfgDir, { recursive: true });
  const hook = () => [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout: 15 }] }];
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' },
    skipDangerousModePermissionPrompt: true,
    hooks: { SessionStart: hook(), UserPromptSubmit: hook(), Stop: hook() },
  }, null, 2));
  const proj = { allowedTools: [], hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
  fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, autoUpdates: false, numStartups: 5,
    officialMarketplaceAutoInstallAttempted: true, officialMarketplaceAutoInstalled: true,
    projects: { [cwd.replace(/\\/g, '/')]: proj, [cwd]: proj },
  }, null, 2));
  const copy = path.join(cfgDir, '.credentials.json');
  fs.copyFileSync(REAL_CREDS, copy);
  liveCopies.add(copy);
}

function assistantTextFrom(cfgDir) {
  const root = path.join(cfgDir, 'projects');
  const parts = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
          try {
            const j = JSON.parse(line);
            if (j.type !== 'assistant') continue;
            for (const b of j.message?.content || []) if (b.type === 'text') parts.push(b.text);
          } catch { /* partial line */ }
        }
      }
    }
  };
  walk(root);
  return parts.join(' | ');
}

function runClaude(cwd, cfgDir, prompt) {
  return new Promise((resolve) => {
    // The prompt goes in on STDIN: with `shell: true` (needed for the .cmd shim on
    // Windows) an argv prompt is split on its spaces and claude sees only its first word.
    const child = spawn('claude', ['-p'], {
      cwd, env: scrubbedEnv(cfgDir), windowsHide: true, shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 180000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let version;
  try { version = execFileSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' }).trim(); }
  catch (e) { console.error(`cannot run claude: ${e.message}`); return 2; }
  let minutes = 0;
  try { minutes = (JSON.parse(fs.readFileSync(REAL_CREDS, 'utf8')).claudeAiOauth.expiresAt - Date.now()) / 60000; } catch { /* 0 */ }
  console.log(`claude version   : ${version}`);
  console.log(`access token life: ${minutes.toFixed(0)} min`);
  if (minutes < opts.minTokenLife) {
    console.error(`REFUSING TO RUN: token has ${minutes.toFixed(0)} min left (< ${opts.minTokenLife}); a copy could be refreshed mid-run.`);
    return 2;
  }

  const rnd = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  const words = { session: `MANGO-${rnd()}`, prompt: `KIWI-${rnd()}`, stop: `PAPAYA-${rnd()}` };
  const run = path.join(PROBE_DIR, `run-${Date.now()}`);
  const cwd = path.join(run, 'cwd'); const cfgDir = path.join(run, 'config');
  fs.mkdirSync(cwd, { recursive: true });

  const hs = await startHookServer(words);
  seedConfig(cfgDir, cwd, hs.port);
  let r; let transcriptText = '';
  try {
    r = await runClaude(cwd, cfgDir,
      'Reply with the session codeword and the prompt codeword from your context, separated by one space, and nothing else.');
    transcriptText = assistantTextFrom(cfgDir);
  } finally {
    shred(path.join(cfgDir, '.credentials.json'));
    hs.server.close();
    if (!opts.keep) { try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  // `-p` prints only the FINAL message, and a Stop block makes a second one — so the
  // first answer (the one the context codewords belong in) is read from the transcript.
  const text = `${transcriptText} | ${r.out}`.trim();
  const verdict = {
    sessionStartContext: text.includes(words.session),
    userPromptSubmitContext: text.includes(words.prompt),
    stopBlockHonoured: text.includes(words.stop),
    stopHookCalls: hs.stopCount(),
    secondStopHadStopHookActive: hs.events.filter((e) => e.ev === 'Stop')[1]?.stop_hook_active === true,
  };
  console.log(`exit code        : ${r.code}`);
  console.log(`events           : ${hs.events.map((e) => e.ev).join(', ')}`);
  console.log(`claude said      : ${JSON.stringify(text.slice(0, 400))}`);
  if (r.err.trim()) console.log(`stderr           : ${JSON.stringify(r.err.trim().slice(0, 400))}`);
  console.log(`VERDICT          : ${JSON.stringify(verdict)}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  for (const p of [...liveCopies]) shred(p);
  console.error(e && e.stack || e);
  process.exit(1);
});
