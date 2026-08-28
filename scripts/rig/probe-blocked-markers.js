#!/usr/bin/env node
'use strict';
// #179 follow-up. probe-altscreen-block.js measured the issue's own candidate
// detector (alt-screen) and DISPROVED it: `/usage` and `/config` swallow a prompt
// while never emitting ESC[?1049h. So this probe asks the open question — what DOES
// change on the wire when the TUI stops being able to accept a prompt?
//
// It records, per state, every DEC private mode toggle (bracketed paste 2004, mouse
// 1000/1002/1003/1006, focus 1004, alt 1049) plus the visible tail, so a real marker
// can be chosen from what this version actually prints.
const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';
const COMPOSER = /❯/;
const STARTED = /esc to interrupt|✻|✽|Crunch|Thinking/i;

function modes(s) {
  const out = [];
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] + m[2]);
  return out;
}
// Collapse to the FINAL state of each mode number.
function finalModes(s) {
  const st = {};
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m;
  while ((m = re.exec(s))) for (const n of m[1].split(';')) st[n] = m[2];
  return st;
}
function visible(s) {
  return s.replace(/\][^]*/g, '')
          .replace(/\x1b[\[\]][?>=]?[0-9;]*[A-Za-z]/g, '')
          .replace(/\x1b./g, '')
          .replace(/\r/g, '\n')
          .replace(/\n{3,}/g, '\n\n');
}
async function waitFor(term, re, ms, from = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(term.text().slice(from))) return Date.now() - t0; await sleep(200); }
  return null;
}
const CASES = [
  { name: 'usage', enter: '/usage\r' },
  { name: 'config', enter: '/config\r' },
  { name: 'slashmenu', enter: '/' },
  { name: 'agentview', enter: `${ESC}[D` },
];
(async () => {
  const cookie = await login();
  for (const c of CASES) {
    const { id } = await api(cookie, 'POST', '/api/sessions', {
      name: `bm-${c.name}`, cwd: DIRS.rig, autoCommand: 'claude --dangerously-skip-permissions', agent: 'claude',
    });
    const term = await openTerminal(cookie, id);
    try {
      if (await waitFor(term, COMPOSER, 60000) === null) { console.log(`${c.name}: no composer`); continue; }
      await sleep(1500);
      const baseModes = finalModes(term.text());
      const at = term.text().length;
      term.send(c.enter);
      await sleep(5000);
      const chunk = term.text().slice(at);
      const after = finalModes(term.text());
      const changed = Object.keys(after).filter((k) => baseModes[k] !== after[k])
        .map((k) => `${k}:${baseModes[k] || '-'}->${after[k]}`);
      const sub = term.text().length;
      term.send('probe prompt do not run'); await sleep(300); term.send('\r');
      const started = await waitFor(term, STARTED, 12000, sub);
      const v = visible(chunk).trim().split('\n').filter(Boolean);
      console.log(`\n######## ${c.name} ########`);
      console.log(`modes emitted : ${modes(chunk).join(' ') || 'NONE'}`);
      console.log(`modes changed : ${changed.join(' ') || 'none'}`);
      console.log(`turn started  : ${started !== null ? 'YES' : 'NO'}`);
      console.log(`--- last 14 visible lines on entering ---`);
      console.log(v.slice(-14).map((l) => '  | ' + l.slice(0, 150)).join('\n'));
    } finally {
      term.close();
      await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
