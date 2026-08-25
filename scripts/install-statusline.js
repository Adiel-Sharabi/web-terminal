#!/usr/bin/env node
'use strict';
// Point this machine's Claude Code status line at the repo-owned pusher
// (scripts/wt-push-status.sh), so POST /api/claude-status receives the FULL
// statusline payload instead of the four numbers the old inline block forwarded.
//
// Sibling of install-hooks.js: the repo owns the machine-local Claude config that
// implements its contracts, because a per-machine copy of a wire format drifts.
// See scripts/wt-push-status.sh for the history of that drift (#71, #69).
//
//   node scripts/install-statusline.js          # patch
//   node scripts/install-statusline.js --check   # report only, change nothing
//
// It patches ONLY the push block and leaves the user's own rendering — memory
// segment, folder|branch, effort — untouched. Rendering is preference; pushing is
// this repo's contract. Run it on every machine after upgrading the server.
//
// TWO THINGS HAVE TO BE TRUE, and this script now checks both — because a machine
// where only one held is SILENT rather than broken-looking, which is how one sat
// unnoticed until someone compared it to another box:
//
//   1. ~/.claude/claude-status.sh forwards the payload (the push block below).
//   2. ~/.claude/settings.json has a `statusLine` entry that RUNS that script.
//
// (2) used to be nobody's job. Claude Code never invokes a status line it was not
// told about, so a perfectly good script sitting at the documented path pushes
// exactly nothing, and the failure surfaces only as an absence: no line in the
// terminal, no ctx/token badge in the sidebar or the companion's chat view. That
// is indistinguishable from "the feature isn't built", so it was assumed to be.
//
// A machine with NO status line at all is likewise seeded rather than refused.
// Refusing was defensible while this only ever patched a block — the file it
// wanted was the user's, and guessing at it would have been the drift this repo
// keeps paying for. But refusing left the operator to hand-write a script whose
// only documented requirement is the one line we already generate, and the
// predictable happened. The seed is a STARTING POINT, not an owned artifact:
// everything outside the two markers is the user's to rewrite, and later runs
// still touch only the block between them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const PORT = process.env.WT_PORT || '7681';

// The compatibility here runs ONE WAY. This server reads both the raw payload and the
// legacy flat push, so an old pusher against a new server is fine. The reverse is not:
// an old server reads a raw payload as four ABSENT numbers and stores a blank report
// over a good one, so every ctx badge on the box goes empty until it is upgraded.
// Hence the gate — install the server first, then run this.
// Asked of /api/claude-status itself, NOT /api/version: the version route is behind
// auth (this script has no credentials), while the status route is localhost-only and
// unauthenticated — the same trust boundary the status line already pushes across. A
// probe POST with no session_id stores nothing and answers `accepts: 'raw'`; a server
// too old to know the field answers without it.
function serverSupportsRawPayload() {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ probe: 'install-statusline' }));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/claude-status', method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ reachable: true, ok: j && j.accepts === 'raw' });
        } catch { resolve({ reachable: true, ok: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, ok: false }); });
    req.on('error', () => resolve({ reachable: false, ok: false }));
    req.end(payload);
  });
}
const DEFAULT_SCRIPT = path.join(os.homedir(), '.claude', 'claude-status.sh');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Claude Code resolves settings with settings.local.json taking PRECEDENCE over
// settings.json, so the status line that actually runs may not be the one in the
// file we write. Consulting only the user file meant a machine configured in
// settings.local.json looked unconfigured, had a statusLine added to a file that
// is permanently overridden, and was then REPORTED FIXED - a green verdict on a
// machine still pushing nothing, which is the failure this tool exists to end.
const SETTINGS_LOCAL = path.join(os.homedir(), '.claude', 'settings.local.json');
// Two spellings of one path, and they are not interchangeable: Node checks the file
// with the NATIVE path, while the line we write into a bash script must be the POSIX
// one Git Bash resolves (C:\dev\… -> /c/dev/…).
const toPosix = (p) => p
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const PUSHER_NATIVE = path.resolve(__dirname, 'wt-push-status.sh');
const PUSHER = toPosix(PUSHER_NATIVE);

const MARKER = 'wt-push-status.sh';
const BLOCK_START = '# --- Push metrics to the local web-terminal server';
const NEW_BLOCK = `# --- Push metrics to the local web-terminal server (companion app / sidebar) ---
# Managed by web-terminal: scripts/install-statusline.js. The payload is forwarded
# VERBATIM and parsed server-side (lib/metrics-claude.js) — do not extract fields here.
if [ -f "${PUSHER}" ]; then
    echo "$INPUT" | bash "${PUSHER}" "$SID" &
fi
`;

// The seed. Deliberately assembled around the SAME NEW_BLOCK the patcher writes, so
// there is one definition of the push block rather than two that must agree — a
// seeded file is byte-identical, in that region, to a patched one, and re-running
// this script on it takes the "already installed" path.
//
// The renderer is one node spawn for the whole payload. This runs on EVERY status
// line render, and Claude re-renders far more often than the numbers change, so a
// spawn per field would be felt.
//
// Fields are separated by 0x1f (UNIT SEPARATOR), not a tab and certainly not a
// space: a model display name ("Opus 4.8") contains spaces, and a TAB is IFS
// WHITESPACE - bash collapses runs of it and drops leading/trailing ones, so one
// absent field shifts every later one LEFT. Measured on this shell:
//   IFS=$'\\t'   over sid/model/effort/<empty>/42/18 -> CTX=42 FIVE=18 SEVEN=
//   IFS=$'\\x1f' over the same                       -> CTX=   FIVE=42 SEVEN=18
// An absent ctx is not exotic - it is every render right after /compact, and a
// model with no effort level does the same one field earlier. The failure is
// silent and renders the 5h number LABELLED as ctx, which is worse than none.
const SEED = `#!/bin/bash
# Claude Code status line.
#
# SEEDED by web-terminal (scripts/install-statusline.js) on a machine that had no
# status line at all. Everything OUTSIDE the marked push block is YOURS — rewrite
# the rendering however you like. Later runs of the installer only ever replace the
# block between "# --- Push metrics" and the next "# --- " header.
#
# Claude Code pipes this script its status payload on stdin and prints whatever we
# write to stdout as the status line.
set -u

INPUT=$(cat)

# node absent is not the same as a payload that would not parse, and 2>/dev/null
# cannot tell you which you have: both render a healthy-looking "folder|branch"
# with every metric missing. Checked separately so the line can SAY so - the
# pusher needs node too, so this is the whole feature being dead, not one field.
NONODE=""
command -v node >/dev/null 2>&1 || NONODE=1

FIELDS=$(printf '%s' "$INPUT" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  let j={};
  try { j=JSON.parse(d)||{}; } catch(e) {}
  const cw=j.context_window||{}, rl=j.rate_limits||{}, m=j.model||{}, ef=j.effort||{};
  const pct=v=>(typeof v==='number'&&isFinite(v))?String(Math.round(v)):'';
  process.stdout.write([
    typeof j.session_id==='string'?j.session_id:'',
    m.display_name||m.id||'',
    ef.level||'',
    pct(cw.used_percentage),
    pct((rl.five_hour||{}).used_percentage),
    pct((rl.seven_day||{}).used_percentage)
  ].join('\\x1f'));
});
" 2>/dev/null)

# Pre-set so 'set -u' is safe when the payload was unparseable and FIELDS is empty.
SID=""
MODEL=""
EFFORT=""
CTX=""
FIVE=""
SEVEN=""
IFS=$'\\x1f' read -r SID MODEL EFFORT CTX FIVE SEVEN <<< "$FIELDS"

${NEW_BLOCK}
# --- Render (yours to change) -------------------------------------------------
DIR=$(basename "$PWD")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

OUT="$DIR"
[ -n "$BRANCH" ] && OUT="$OUT|$BRANCH"
[ -n "$MODEL" ] && OUT="$OUT · $MODEL"
[ -n "$EFFORT" ] && OUT="$OUT · $EFFORT"
[ -n "$CTX" ] && OUT="$OUT · ctx \${CTX}%"
[ -n "$FIVE" ] && OUT="$OUT · 5h \${FIVE}%"
[ -n "$SEVEN" ] && OUT="$OUT · 7d \${SEVEN}%"
[ -n "$NONODE" ] && OUT="$OUT · no node"

printf '%s' "$OUT"
`;

function fail(msg) {
  console.error('install-statusline: ' + msg);
  process.exit(1);
}

// (2) of the two conditions. Reported and repaired independently of the script,
// because either half can be missing on its own and a half-installed machine looks
// exactly like an uninstalled one.
//
// An EXISTING statusLine is never rewritten: pointing it somewhere else would throw
// away a rendering the user chose. We only ever fill an absence.
//
// But "left alone" is NOT the same as "fine", and saying so was a real defect: the
// push block goes into ~/.claude/claude-status.sh, which is only the right file if
// that is what statusLine actually runs. With it pointing at some other script and
// claude-status.sh absent, the seed was written, nothing ran it, nothing was pushed,
// and the run exited 0 saying "Created" - a green verdict on precisely the silent
// half-install this tool exists to detect. A foreign command is now resolved to the
// script it names and only passes if THAT file already forwards the payload;
// otherwise it fails with the one line to add and where to add it.
// The script a status-line command runs, or null when the command names none we
// can patch (npx, a .py/.js renderer, a shell one-liner).
//
// Not a single regex over the whole command, because the shapes that break it are
// all ordinary. A QUOTED path is authoritative and may contain spaces; an unquoted
// one still may (`bash /c/Users/John Doe/x.sh` fed to a first-non-space-run match
// returns "Doe/x.sh"); and an interpreter this list does not know
// (`/usr/bin/env bash ~/x.sh`, a quoted `bash.exe`) leaves a whole COMMAND that
// itself ends in .sh.
//
// That last one is the one that bit: returning the command whole made the caller
// treat "/usr/bin/env bash ~/.claude/statusline.sh" as a path, create
// `C:\usr\bin\env bash ~\.claude\statusline.sh` on the drive root, never touch the
// real status line, and exit 0 reporting success. So a bare trailing ".sh" is only
// ever trusted when we know what precedes it: nothing, or a lead we stripped
// ourselves. Everything else falls through to the token scan, and an unrecognised
// command returns null and is REPORTED rather than guessed at.
function scriptInCommand(cmd) {
  const t = cmd.trim();
  const isSh = (x) => x.toLowerCase().endsWith('.sh');
  // Distinguishes a path from a flag or an interpreter's bare name, so `bash -l
  // ~/x.sh` cannot yield "-l ~/x.sh".
  const looksLikePath = (x) => x.startsWith('/') || x.startsWith('~') ||
    x.startsWith('.') || (x.length > 2 && x.charAt(1) === ':');

  // 1. Any quoted run, not merely the first: a Windows command opens with a
  //    quoted INTERPRETER (`"C:/Program Files/Git/bin/bash.exe" ~/x.sh`), so
  //    stopping at the first pair reads bash.exe as the status line.
  for (const quote of ['"', "'"]) {
    let i = t.indexOf(quote);
    while (i !== -1) {
      const end = t.indexOf(quote, i + 1);
      if (end === -1) break;
      const inner = t.slice(i + 1, end);
      if (isSh(inner)) return inner;
      i = t.indexOf(quote, end + 1);
    }
  }

  // 2. A lead we recognise and actually stripped is the ONLY case where an
  //    unquoted path may still contain spaces.
  for (const lead of ['/bin/bash ', '/bin/sh ', 'bash ', 'sh ']) {
    if (t.toLowerCase().startsWith(lead)) {
      const rest = t.slice(lead.length).trim();
      if (isSh(rest) && looksLikePath(rest)) return rest;
      break;
    }
  }

  // 3. Otherwise only a single bare path may be taken whole; anything with a
  //    space is scanned token by token.
  if (isSh(t) && t.indexOf(' ') === -1) return t;
  return t.split(' ').find(isSh) || null;
}

// `bash ~/.claude/claude-status.sh` is the form Claude Code's own docs use, and
// an unexpanded ~ compares equal to nothing: the machine's OWN status line then
// reads as somebody else's, and a correctly configured box gets refused.
const expandHome = (q) => {
  const home = toPosix(os.homedir());
  if (q === '~') return home;
  if (q.startsWith('~/')) return home + '/' + q.slice(2);
  for (const v of ['${HOME}/', '$HOME/']) {
    if (q.startsWith(v)) return home + '/' + q.slice(v.length);
  }
  return q;
};

const samePath = (a, b) => toPosix(a).toLowerCase() === toPosix(b).toLowerCase();
// The inverse of toPosix, so a POSIX path read out of a command can be stat'd.
const fromPosix = (q) => /^\/[A-Za-z]\//.test(q)
  ? q.charAt(1).toUpperCase() + ':' + q.slice(2).replace(/\//g, path.sep)
  : q;

function statusLineIn(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true, raw: '{}' };
    return { unreadable: e.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { unparseable: e.message, raw };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { unparseable: 'not a JSON object', raw };
  }
  const sl = parsed.statusLine;
  const cmd = sl && typeof sl === 'object' ? sl.command : null;
  return {
    raw,
    parsed,
    command: typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null,
  };
}

// WHERE the push block goes is decided by what the machine is configured to run,
// not by our own default path. Three review rounds landed on the same root cause
// from different directions: treating the settings half as a GATE on the push
// half is wrong in both directions. Seeding claude-status.sh beside a statusLine
// that runs something else creates a file nothing runs and reports success for
// it; refusing outright, as the previous cut did, blocks the push block on a
// machine that is correctly configured and merely spells its path with a ~.
//
// So: resolve the configured script, and patch THAT. Only when nothing is
// configured do we fall back to our own path and add the setting to match.
function resolveConfigured() {
  for (const [file, where] of [[SETTINGS_LOCAL, 'settings.local.json'], [SETTINGS, 'settings.json']]) {
    const r = statusLineIn(file);
    // An unreadable/unparseable settings file is refused SYMMETRICALLY, whichever
    // of the two it is. Skipping a broken settings.local.json and writing to
    // settings.json instead produced the exact false-green this block prevents:
    // a statusLine added to a file the broken one overrides, reported as fixed.
    if (r.unreadable) return { error: `could not read ${file}: ${r.unreadable}` };
    if (r.unparseable) return { error: `${file} is not valid JSON (${r.unparseable}); left untouched.` };
    if (r.command) {
      const named = scriptInCommand(r.command);
      if (!named) return { where, command: r.command, opaque: true };
      return { where, command: r.command, script: fromPosix(expandHome(named)) };
    }
  }
  return { none: true };
}

const CONFIGURED = resolveConfigured();
// The script we will read, patch or seed. Following the configuration is what
// makes "the push block is installed into whatever script that entry already
// runs" a true statement rather than a comment that lied.
const SCRIPT = CONFIGURED.script || DEFAULT_SCRIPT;
const SCRIPT_POSIX = toPosix(SCRIPT);

function ensureStatusLineSetting(apply) {
  if (CONFIGURED.error) return { ok: false, msg: CONFIGURED.error };
  if (CONFIGURED.opaque) {
    // Nothing to patch and nowhere to put it. Saying so is the only honest
    // answer: writing our own script here would be a decoy nothing runs.
    return {
      ok: false,
      msg: `${CONFIGURED.where} runs ${CONFIGURED.command}, which names no .sh script we can patch.\n` +
        `  Nothing was changed - forward the payload from it yourself, after it reads stdin:\n` +
        `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`,
    };
  }
  if (CONFIGURED.script) {
    // Their renderer, their choice - and the push block is going into it, so
    // there is nothing to add here and nothing wrong with the machine.
    return {
      ok: true,
      changed: false,
      msg: `${CONFIGURED.where} already runs a status line (${CONFIGURED.command}) - left alone; the push block goes in that script.`,
    };
  }

  const user = statusLineIn(SETTINGS);
  // Quoted: a home directory containing a space ("John Doe") would otherwise
  // hand bash two arguments and the status line would silently do nothing --
  // the same invisible absence this script exists to remove.
  const command = `bash "${SCRIPT_POSIX}"`;
  if (!apply) return { ok: true, changed: true, msg: `would add settings.json statusLine -> ${command}` };

  try {
    // Keyed on the file's ABSENCE, not on its contents happening to equal the
    // '{}' we substituted for it - a real settings.json of '{}' got no backup.
    if (!user.missing) fs.copyFileSync(SETTINGS, SETTINGS + '.bak');
    const next = user.parsed || {};
    next.statusLine = { type: 'command', command, padding: 0 };
    fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  } catch (e) {
    return { ok: false, msg: `could not write ${SETTINGS}: ${e.message}` };
  }
  return { ok: true, changed: true, msg: `Added settings.json statusLine -> ${command}` };
}

if (!fs.existsSync(PUSHER_NATIVE)) fail(`pusher missing at ${PUSHER_NATIVE} — is the repo checked out fully?`);

// What to write into the status-line script, or the reason we will not. This
// RETURNS its refusals instead of calling fail(), because every one of them names
// SCRIPT — and when the settings half could not identify SCRIPT, that name is a
// guess. The caller reports the settings half first, so an operator is never told
// to hand-patch a file that nothing on the machine runs.
function planPushBlock() {
  const seeding = !fs.existsSync(SCRIPT);

  // A configured script that is not on disk is usually a machine whose statusLine
  // was pointed at a renderer before that renderer existed — and seeding it there
  // is the fix, not a hazard. What must never happen is inventing the DIRECTORY
  // TREE as well: `/usr/bin/env bash ~/.claude/statusline.sh`, which this script
  // once misread whole as a path, has no existing parent, and creating one is how
  // a misparse became a real file on a real disk while the run exited 0 saying
  // "Created".
  //
  // So the rule is structural rather than another special case: at a path we did
  // not choose we may create a FILE, never a DIRECTORY. It holds even if some
  // future command shape defeats scriptInCommand again, which the last four
  // rounds of this review suggest is the way to bet. Our own default path is
  // exempt — that one we chose, and a fresh machine may have no ~/.claude yet.
  if (seeding && CONFIGURED.script && !samePath(SCRIPT, DEFAULT_SCRIPT) &&
      !fs.existsSync(path.dirname(SCRIPT))) {
    return {
      error: `${CONFIGURED.where} runs ${CONFIGURED.command}, but ${SCRIPT} does not exist\n` +
        `  and neither does the directory that would hold it.\n` +
        `  Nothing was changed and NO file was created there — that path looks misread\n` +
        `  rather than merely empty. Fix that setting, or add this line to the script it\n` +
        `  should name, after that script reads stdin:\n` +
        `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`,
    };
  }
  if (seeding) return { seeding, out: SEED };

  const src = fs.readFileSync(SCRIPT, 'utf8');
  if (src.includes(MARKER)) return { seeding, out: null };

  // The script must expose the two variables the injected line uses. If it does not,
  // this is not the script we think it is: report and stop rather than write a block
  // that would silently push nothing.
  for (const v of ['INPUT', 'SID']) {
    if (!new RegExp(`^\\s*${v}=`, 'm').test(src)) {
      return {
        error: `${SCRIPT} defines no $${v}, so the injected push would be empty.\n` +
          `  Nothing was changed. Add this line yourself, after the script reads stdin:\n` +
          `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`,
      };
    }
  }

  const start = src.indexOf(BLOCK_START);
  if (start === -1) {
    return {
      error: `could not find the existing push block in ${SCRIPT}.\n` +
        `  Nothing was changed — the file was NOT guessed at. Add this line yourself,\n` +
        `  anywhere after the script reads stdin into $INPUT:\n` +
        `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`,
    };
  }
  // The block runs to the next top-level `# --- ` section header. Bounded that way
  // rather than by counting `fi`s, which nested conditionals would break.
  const rest = src.slice(start);
  const nextHeader = rest.indexOf('\n# --- ', 1);
  if (nextHeader === -1) {
    return {
      error: `the push block in ${SCRIPT} has no following section header, so its end\n` +
        `  cannot be determined safely. Nothing was changed — patch it by hand.`,
    };
  }
  return { seeding, out: src.slice(0, start) + NEW_BLOCK + rest.slice(nextHeader + 1) };
}

(async () => {
  // Read the settings half FIRST, and never write anything before it has been
  // read. Two reasons, both of which used to bite:
  //
  //  * it must be REPORTED even when the server gate below stops us. A machine
  //    with an old or unreachable server is precisely the one most likely to be
  //    missing condition (2), and exiting on the gate said nothing about it at
  //    all — the silent half-install this script exists to surface.
  //  * a seeding run that CREATED claude-status.sh and only then discovered an
  //    unparseable settings.json left behind a script that nothing runs, which
  //    is the same half-installed shape from the other direction.
  const settingsPlan = ensureStatusLineSetting(false);

  // ...and only THEN decide what to do with the script, because which script that
  // is comes out of the settings half. A refusal here used to be raised at module
  // load, before any of the above had been read, so a machine whose statusLine we
  // could not identify was told to hand-patch ~/.claude/claude-status.sh — a file
  // its settings never mentioned.
  const plan = planPushBlock();
  if (plan.error) {
    console.error('install-statusline: status line setting: ' + settingsPlan.msg);
    fail(plan.error);
  }
  const { out, seeding } = plan;

  // The server gate guards only the PUSH half. It is asked for whenever we would
  // write a push block; the settings half is unaffected by server version.
  if (out !== null) {
    const gate = await serverSupportsRawPayload();
    if (!gate.ok && !FORCE) {
      // Say what we know about the other half before dying on this one.
      console.error('install-statusline: status line setting: ' + settingsPlan.msg);
      if (!gate.reachable) {
        fail(`no web-terminal server answering on 127.0.0.1:${PORT}, so its version could\n` +
          `  not be confirmed. Nothing was changed. Start the server and re-run, or pass\n` +
          `  --force if you know it is already on a build with 'claude-status-raw'.`);
      }
      fail(`the server on 127.0.0.1:${PORT} lacks the\n` +
        `  'claude-status-raw' capability. Nothing was changed — installing now would blank\n` +
        `  every ctx badge on this machine, because an older server reads the raw payload as\n` +
        `  four absent numbers and stores that over the real ones.\n` +
        `  DEPLOY ORDER: update + restart the server FIRST, then re-run this.`);
    }
  }

  if (CHECK) {
    if (out === null) console.log('Push block: already installed — status line forwards the raw payload.');
    else if (seeding) console.log(`Push block: would CREATE ${SCRIPT} (no status line on this machine).`);
    else console.log(`Push block: would patch ${SCRIPT} (push block -> ${PUSHER}).`);
    console.log('Status line setting: ' + settingsPlan.msg);
    // Covers BOTH halves: a broken push half has already exited 1 above, having
    // reported this one first. Reaching here means the only verdict left is this.
    process.exit(settingsPlan.ok ? 0 : 1);
  }

  // Refuse to write a push block we already know we cannot finish wiring up.
  if (!settingsPlan.ok) fail(settingsPlan.msg);

  if (out === null) {
    console.log('Push block: already installed — status line forwards the raw payload. No change.');
  } else {
    // Announced AFTER the write lands. A failing writeFileSync throws, and the
    // "Patched"/"Created" line had already been printed by then — leaving a run
    // that says it patched a file it did not, which is the exact false-green this
    // whole script exists to remove.
    let backup = null;
    if (!seeding) {
      backup = SCRIPT + '.bak';
      fs.copyFileSync(SCRIPT, backup);
    } else {
      fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
    }
    fs.writeFileSync(SCRIPT, out);
    console.log(`${seeding ? 'Created' : 'Patched'} ${SCRIPT}`);
    if (backup) console.log(`  backup: ${backup}`);
    console.log(`  pusher: ${PUSHER}`);
  }

  const st = ensureStatusLineSetting(true);
  console.log('Status line setting: ' + st.msg);
  if (!st.ok) process.exit(1);

  console.log('The next status-line render forwards the full payload (window size + 5h reset time).');
  if (st.changed) console.log('Restart your Claude Code sessions — the statusLine setting is read at startup.');
})();
