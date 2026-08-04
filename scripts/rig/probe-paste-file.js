// What does Claude actually DO with an absolute file path delivered as a
// bracketed paste? #90 delivers dropped files that way, reusing #29's image
// mechanism — but Claude's paste handler is documented (server.js) as detecting
// absolute IMAGE paths. This measures the non-image case instead of assuming it.
//
// The verdict comes from the TRANSCRIPT, never the screen: we need to know what
// Claude RECEIVED, and the screen cannot distinguish "shown in the composer" from
// "submitted as part of the turn".
//
// Usage: node scripts/rig/probe-paste-file.js --file <abs-path> [--text "..."]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pty = require(path.join(__dirname, '..', '..', 'node_modules', 'node-pty'));
const { claudeProjectDirName } = require(path.join(__dirname, '..', '..', 'lib', 'transcript.js'));

function arg(n, d) {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const FILE = arg('file', '');
const TEXT = arg('text', 'What is the file I just attached? Name it exactly.');
if (!FILE || !fs.existsSync(FILE)) throw new Error('--file must be an existing absolute path');

function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const guess = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(guess)) return guess;
  const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).find(l => l.trim()).trim();
}

const deansi = s => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[[\]][0-9;?]*[A-Za-z]/g, '')
  .replace(/[\r\n]+/g, '\n');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-'));
const env = { ...process.env };
delete env.CLAUDE_CODE_CHILD_SESSION; // else no transcript is written at all
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CLAUDE_CODE_ENTRYPOINT;

const p = pty.spawn(resolveClaude(), ['--dangerously-skip-permissions'], {
  name: 'xterm-256color', cols: 100, rows: 34, cwd, env,
});

let buf = '';
let last = Date.now();
let state = 'trust';
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);

p.onData(d => {
  buf += d; last = Date.now();
  if (state === 'trust' && /trust/i.test(deansi(buf))) {
    state = 'trusting';
    setTimeout(() => { p.write('\r'); state = 'settle'; buf = ''; console.log('[' + stamp() + '] trust accepted'); }, 500);
  }
});

const tick = setInterval(async () => {
  if (state === 'settle' && Date.now() - last > 2500) {
    state = 'sending';
    console.log('[' + stamp() + '] delivering the path exactly as #90 does');
    // EXACTLY what _ComposeAttachment.reference emits, then the prompt + submit.
    // --app-sequence replays it the way _sendCompose really does: every
    // attachment frame and then the prompt, back to back with NO gap and NO
    // separator between them. --file2 adds a second attachment (a multi-file
    // drop), which is where a missing separator would first show.
    const appSeq = process.argv.includes('--app-sequence');
    const FILE2 = arg('file2', '');
    if (process.argv.includes('--combined')) {
      // The candidate fix: ONE bracketed paste, every path on its own line, the
      // prompt last. One frame (so #44 still holds), no fusion, nothing folded.
      const body = [FILE, FILE2, TEXT].filter(Boolean).join('\n');
      p.write('\x1b[200~' + body + '\x1b[201~');
      await new Promise(r => setTimeout(r, 700));
      console.log('--- composer before submit (combined) ---');
      console.log(deansi(buf).split('\n').slice(-4).join('\n'));
      p.write('\r');
      console.log('[' + stamp() + '] submitted; waiting for the turn');
      return setTimeout(verdict, 40000);
    }
    p.write('\x1b[200~' + FILE + '\x1b[201~');
    if (FILE2) p.write('\x1b[200~' + FILE2 + '\x1b[201~');
    if (!appSeq) await new Promise(r => setTimeout(r, 900));
    console.log('--- composer right after the paste ---');
    console.log(deansi(buf).split('\n').slice(-6).join('\n'));
    p.write(TEXT);
    await new Promise(r => setTimeout(r, appSeq ? 60 : 700));
    console.log('--- composer just before submit ---');
    console.log(deansi(buf).split('\n').slice(-6).join('\n'));
    p.write('\r');
    console.log('[' + stamp() + '] submitted; waiting for the turn');
    setTimeout(verdict, 40000);
  }
}, 500);

function verdict() {
  clearInterval(tick);
  try { p.kill(); } catch { /* gone */ }
  const dir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
  console.log('\n================ VERDICT (transcript) ================');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {
    console.log('NO TRANSCRIPT — nothing was ever submitted.');
    return done();
  }
  const base = path.basename(FILE);
  for (const f of files) {
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let o; try { o = JSON.parse(raw); } catch { continue; }
      const m = o && o.message;
      if (!m || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (m.role === 'user' && b.type === 'text') {
          console.log('USER TURN TEXT: ' + JSON.stringify(String(b.text).slice(0, 400)));
          console.log('  contains the full path?  ' + String(b.text).includes(FILE));
          console.log('  contains the basename?   ' + String(b.text).includes(base));
        }
        if (m.role === 'user' && b.type !== 'text') console.log('USER TURN BLOCK TYPE: ' + b.type);
        if (b.type === 'tool_use') console.log('TOOL: ' + b.name + ' ' + JSON.stringify(b.input).slice(0, 160));
        if (m.role === 'assistant' && b.type === 'text' && b.text.trim()) {
          console.log('ASSISTANT: ' + b.text.replace(/\s+/g, ' ').slice(0, 300));
        }
      }
    }
  }
  done();
}

function done() {
  console.log('\n(temp cwd: ' + cwd + ')');
  setTimeout(() => process.exit(0), 300);
}

setTimeout(() => { if (state !== 'done') { console.log('[' + stamp() + '] TIMEOUT state=' + state); verdict(); } }, 120000);
