// #78 Step 0 — drives the INTERACTIVE codex TUI over a real PTY for the two
// events that `codex exec` cannot reach at all:
//
//   PermissionRequest -- `codex exec` hard-codes approval_policy=Never
//     internally (measured: codex_core::tools::router logs "approval policy is
//     Never; reject command" and neither `-c approval_policy=...` nor the
//     interactive-only `-a/--ask-for-approval` flag is accepted by `exec`).
//     There is nobody to ask in a non-interactive process, so escalation is
//     just rejected -- PermissionRequest is structurally exec-mode-unreachable,
//     not merely untested. Only the interactive TUI has an approval UI to
//     answer.
//
//   PreCompact / PostCompact -- there is no `codex exec compact`; `/compact`
//     is a TUI slash command.
//
// Usage: node codex-pty-drive.js <permission|compact> <codexHomeDir> <workDir>
// Exit code 0 = the scenario's hooks were observed to fire (caller still
// checks the capture directory for the actual payloads). Exit code 3 = this
// driver itself crashed for an ENVIRONMENT reason unrelated to codex/hooks
// (see below) -- report that honestly, do not treat it as "hooks don't work".
//
// KNOWN ENVIRONMENT HAZARD, reproduced 2026-08-28 on a Windows host while building
// this probe, and confirmed with a plain `pty.spawn('cmd.exe', ...)` repro that
// has NOTHING to do with codex: in a node-pty session nested inside this
// harness (Bash tool -> git-bash -> node), EITHER `p.write()` or `p.kill()` can
// trigger node-pty's internal conpty_console_list_agent.js helper, whose
// `AttachConsole` call fails and crashes the whole PTY session with exit code
// -1073741510 (STATUS_DLL_NOT_FOUND-shaped). Passing `useConptyDll: true`
// (production's own setting, see pty-worker.js) avoids that specific crash
// signature, but was independently observed to make codex's own interactive
// TUI exit with a bare code 1 a couple of seconds after boot for a DIFFERENT,
// still-unexplained reason (never reproduced with useConptyDll on a plain
// cmd.exe PTY, which behaved perfectly). Neither backend was 100% reliable for
// the interactive TUI in this harness across repeated runs; a real terminal
// window (not this nested Bash-tool session) is expected NOT to hit this.
'use strict';
const fs = require('fs');
const path = require('path');
const pty = require(path.join(__dirname, '..', '..', 'node_modules', 'node-pty'));

const MODE = process.argv[2];
const HOME = process.argv[3];
const WORK = process.argv[4];
if (!['permission', 'compact'].includes(MODE) || !HOME || !WORK) {
  process.stderr.write('usage: codex-pty-drive.js <permission|compact> <codexHomeDir> <workDir>\n');
  process.exit(2);
}
// Spawn the `codex.cmd` npm shim directly (node-pty/ConPTY can execute a
// .cmd natively -- no EINVAL, no shell hop to reason about). See
// probe-codex-hook-payloads.js for why the exec-mode path specifically avoids
// bypassing this shim: doing so was measured to silently starve every hook of
// its stdin payload.
const CODEX_CMD = process.env.CODEX_BIN || path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'codex.cmd');
const OUT_FILE = process.argv[5]; // optional: write final deansi'd transcript here

const deansi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[[\]][0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '');

const args = MODE === 'permission'
  ? ['--dangerously-bypass-hook-trust', '-s', 'read-only', '-a', 'on-request']
  : ['--dangerously-bypass-hook-trust'];

const p = pty.spawn(CODEX_CMD, args, {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: WORK,
  env: Object.assign({}, process.env, { CODEX_HOME: HOME }),
});

let buf = '';
let nagDismissed = false;
let composerSeenAt = null;
let promptSent = false;
let approvalAnswered = false;
let firstReplySeenAt = null;
let compactSent = false;

const PROMPT = MODE === 'permission'
  ? 'run a shell command that writes a file'
  : 'say ok please, do not use any tools';

p.onData((d) => {
  buf += d;
  const clean = deansi(buf);

  // The "Update available" nag blocks EVERY session with an interactive
  // prompt. Dismiss with Esc, NEVER Enter -- Enter can select "Update now".
  if (!nagDismissed && /Update available|Press enter to continue/i.test(clean)) {
    nagDismissed = true;
    setTimeout(() => p.write('\x1b'), 400);
  }

  if (!composerSeenAt && /stub-model default/i.test(clean)) composerSeenAt = Date.now();

  if (composerSeenAt && !promptSent && Date.now() - composerSeenAt > 1500) {
    promptSent = true;
    p.write(PROMPT);
    setTimeout(() => p.write('\r'), 500);
  }

  if (MODE === 'permission' && promptSent && !approvalAnswered && /Press enter to confirm/i.test(clean)) {
    approvalAnswered = true;
    setTimeout(() => { p.write('1'); setTimeout(() => p.write('\r'), 300); }, 400);
  }

  if (MODE === 'compact' && promptSent && !firstReplySeenAt && /(^|\n)\s*[••]\s*ok\b/i.test(clean)) {
    firstReplySeenAt = Date.now();
  }
  if (MODE === 'compact' && firstReplySeenAt && !compactSent && Date.now() - firstReplySeenAt > 2000) {
    compactSent = true;
    p.write('/compact');
    setTimeout(() => p.write('\r'), 600);
  }
});

let exited = false;
p.onExit((e) => { exited = true; console.log('[codex-pty-drive] PTY exit code=' + e.exitCode); });

process.on('uncaughtException', (e) => {
  console.log('[codex-pty-drive] ENVIRONMENT CRASH (not a codex/hooks failure) -- ' + e.message);
  if (OUT_FILE) { try { fs.writeFileSync(OUT_FILE, deansi(buf)); } catch (e2) { /* ignore */ } }
  process.exit(3);
});

setTimeout(() => {
  if (OUT_FILE) { try { fs.writeFileSync(OUT_FILE, deansi(buf)); } catch (e) { /* ignore */ } }
  if (!exited) { try { p.kill(); } catch (e) { /* ignore -- see header hazard note */ } }
  setTimeout(() => process.exit(0), 300);
}, MODE === 'permission' ? 18000 : 30000);
