#!/usr/bin/env node
'use strict';
// Install this machine's Claude Code hooks — the channel web-terminal reads session
// status, questions, prompts and conversation identity from.
//
// Sibling of install-statusline.js and install-codex-notify.js: the repo owns the
// machine-local agent config that implements its contracts, because a per-machine copy
// of a wire format drifts. This one existed only as a REFERENCE ("fix-hooks.js") in its
// siblings' headers and never as a file, so the hook set had no owner here at all — and
// that is exactly how every machine ended up missing SessionStart without anyone
// noticing. A rule with no gate is violated within weeks.
//
//   node scripts/install-hooks.js           # patch
//   node scripts/install-hooks.js --check    # report only, change nothing
//
// SessionStart is the one worth explaining, because its absence produced a bug that
// looked like a rendering fault. Every other event fires only once the user is ALREADY
// interacting, so a session that has started (or resumed a conversation) and not yet
// been prompted reports NOTHING — the server never learns its conversation id, and the
// chat lens 404s beside a perfectly live terminal. Observed on XPS 2026-08-12.
//
// Measured, not assumed (claude 2.1.x, project-level probe with UserPromptSubmit as the
// control so a broken probe could not read as "it does not fire"):
//   fresh start      -> SessionStart fires
//   claude --resume  -> SessionStart fires, source = "resume"
//   payload carries  -> session_id, transcript_path (the REAL path), cwd
// `transcript_path` is what makes this cwd-independent: the server stashes it directly,
// so it is right even when the agent runs somewhere other than where its shell started.
//
// Existing hooks on an event are PRESERVED — only web-terminal's own http entry (matched
// by URL path) is added or corrected. The user's unrelated hooks are not this repo's.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = process.argv.includes('--check');
const PORT = process.env.WT_PORT || '7681';
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_URL = `http://127.0.0.1:${PORT}/api/hook`;

// The events web-terminal consumes. Order is cosmetic; membership is the contract.
// Each is handled in pty-worker.js handleHook() — an event that switch does not know
// still pins the conversation id and stashes the transcript path (both happen ABOVE the
// switch) and changes no status, which is precisely why SessionStart is safe to add.
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'PreCompact',
];

// `$WT_SESSION_ID` is expanded by Claude Code from the env the PTY was spawned with, so
// the hook identifies the web-terminal session without the agent knowing anything about
// it. allowedEnvVars is required or the placeholders travel literally.
function wtHook() {
  return {
    type: 'http',
    url: HOOK_URL,
    headers: { 'X-WT-Session-ID': '$WT_SESSION_ID', 'X-WT-Hook-Token': '$WT_HOOK_TOKEN' },
    allowedEnvVars: ['WT_SESSION_ID', 'WT_HOOK_TOKEN'],
  };
}

// Ours is any http hook pointing at /api/hook, on ANY port: a machine whose server moved
// ports must be corrected, not given a second stale entry that fires into the void.
function isWtHook(h) {
  return h && h.type === 'http' && typeof h.url === 'string' && /\/api\/hook\/?$/.test(h.url);
}

function patch(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  const added = [], corrected = [];
  const want = wtHook();

  for (const event of EVENTS) {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    let found = false;
    for (const group of groups) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (let i = 0; i < hooks.length; i++) {
        if (!isWtHook(hooks[i])) continue;
        found = true;
        if (JSON.stringify(hooks[i]) !== JSON.stringify(want)) {
          hooks[i] = want;
          corrected.push(event);
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [wtHook()] });
      added.push(event);
    }
    out.hooks[event] = groups;
  }
  return { settings: out, added, corrected };
}

function main() {
  if (!fs.existsSync(path.dirname(SETTINGS))) {
    console.error(`No ${path.dirname(SETTINGS)} — is Claude Code installed for this user?`);
    process.exit(1);
  }
  let src = {};
  if (fs.existsSync(SETTINGS)) {
    try {
      src = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    } catch (e) {
      // Never overwrite a file we could not parse — that would destroy the user's config.
      console.error(`${SETTINGS} is not valid JSON (${e.message}); refusing to touch it.`);
      process.exit(1);
    }
  }

  const { settings, added, corrected } = patch(src);
  if (added.length === 0 && corrected.length === 0) {
    console.log(`hooks already correct (${SETTINGS})`);
    console.log(`  ${EVENTS.length} events -> ${HOOK_URL}`);
    return;
  }
  const summary = [
    added.length ? `add ${added.join(', ')}` : '',
    corrected.length ? `correct ${[...new Set(corrected)].join(', ')}` : '',
  ].filter(Boolean).join('; ');

  if (CHECK) {
    console.log(`WOULD ${summary}`);
    return;
  }

  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak-wt-${Date.now()}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`patched ${SETTINGS} (${summary})`);
  console.log('NOTE: hooks are read per agent launch — running sessions keep the old set');
  console.log('      until their next start/resume. No server restart is needed.');
}

if (require.main === module) main();
module.exports = { patch, isWtHook, EVENTS };
