#!/usr/bin/env node
'use strict';
// #316 — can the WORKER tell, from the raw PTY byte stream alone, that a Claude session
// is parked in a menu or panel (its composer unreachable, so a prompt goes nowhere)?
//
// #179 measured that no blocking state emits a distinguishing DEC mode, and #210
// measured the rule on a RENDERED screen (the composer marker within 7 rows of the
// foot). The worker renders nothing, so this probe asks the byte-stream question: after
// each action, which comes LAST in the stream — the composer marker (lib/agents.js
// readiness.composer, never a second copy here), or a panel/menu footer? And after Esc,
// does the composer marker come back?
//
// Per case it prints only POSITIONS and the matched footer phrases, never the screen:
// `/status` shows the account and organisation, and this repo is public. The raw
// captures stay in the rig's scratch dir.
//
// Usage:  node scripts/rig/rig.js up   &&   node scripts/rig/probe-menu-state.js [case...]
const fs = require('fs');
const path = require('path');
const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');
const { readinessMarker } = require('../../lib/agents');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';
const COMPOSER = readinessMarker('claude');
const OUT = path.join(DIRS.rig, 'menu-state-captures');

const CASES = [
  { name: 'idle', enter: null },
  { name: 'status', enter: '/status\r' },
  { name: 'usage', enter: '/usage\r' },
  { name: 'config', enter: '/config\r' },
  { name: 'model', enter: '/model\r' },
  { name: 'slash', enter: '/' },
  { name: 'slash-narrow', enter: '/usa' },
  { name: 'agentview', enter: `${ESC}[D` },
  { name: 'turn', enter: 'Reply with just the word OK.\r', wait: 25000 },
];
const ONLY = process.argv.slice(2);

// Claude positions words with CHA and emits no spaces (#190): put a space where a CHA
// was, then strip the remaining escapes, so a footer phrase can be read.
function readable(s) {
  return s
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

const FOOTER = /(esc|enter|tab|space|↑|←)[^\n]{0,4}to [a-z]+/gi;

function lastIndex(re, s) {
  let i = -1;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(s))) { i = m.index; if (m[0].length === 0) g.lastIndex++; }
  return i;
}

function report(label, raw) {
  const composerAt = lastIndex(COMPOSER, raw);
  const text = readable(raw);
  const footers = [...new Set((text.match(FOOTER) || []).map((f) => f.replace(/\s+/g, ' ').trim()))];
  // Where is the last footer phrase in the RAW stream? Search the raw bytes for the
  // phrase's first word after a CHA-insensitive collapse: approximate with "to <verb>".
  const tail = raw.slice(Math.max(0, composerAt));
  const footersAfterComposer = [...new Set((readable(tail).match(FOOTER) || []).map((f) => f.replace(/\s+/g, ' ').trim()))];
  return { label, bytes: raw.length, composerAt, composerFromEnd: composerAt < 0 ? null : raw.length - composerAt, footers, footersAfterComposer };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cookie = await login();
  const results = [];
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.name)) continue;
    const { id } = await api(cookie, 'POST', '/api/sessions', {
      name: `ms-${c.name}`, cwd: DIRS.rig, autoCommand: 'claude --dangerously-skip-permissions', agent: 'claude',
    });
    const term = await openTerminal(cookie, id);
    try {
      term.ws.send(JSON.stringify({ resize: { cols: 120, rows: 30 } }));
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < 90000) {
        if (COMPOSER.test(term.text())) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) { console.log(`${c.name}: NO COMPOSER in 90s — skipped`); continue; }
      await sleep(2500);
      const base = term.text().length;
      if (c.enter) term.send(c.enter);
      await sleep(c.wait || 6000);
      const afterOpen = term.text().slice(base);
      // Idle repaint check: anything the TUI writes over the next 8s while we do nothing.
      const mid = term.text().length;
      await sleep(8000);
      const idleWrites = term.text().slice(mid);
      // Then Esc, and see whether the composer comes back.
      const preEsc = term.text().length;
      term.send(ESC);
      await sleep(3000);
      const afterEsc = term.text().slice(preEsc);
      fs.writeFileSync(path.join(OUT, `${c.name}.open.txt`), afterOpen, 'utf8');
      fs.writeFileSync(path.join(OUT, `${c.name}.esc.txt`), afterEsc, 'utf8');
      const r = {
        name: c.name,
        open: report('open', afterOpen),
        idleWrites: { bytes: idleWrites.length, composer: COMPOSER.test(idleWrites), footers: [...new Set((readable(idleWrites).match(FOOTER) || []).map((f) => f.replace(/\s+/g, ' ').trim()))] },
        esc: { bytes: afterEsc.length, composerBack: COMPOSER.test(afterEsc) },
      };
      results.push(r);
      console.log(JSON.stringify(r));
    } finally {
      term.close();
      await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
