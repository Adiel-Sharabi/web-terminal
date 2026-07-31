// @ts-check
// lib/waiting-for.js — what a blocked session is blocked ON (#79).
//
// The bug: the chat lens rendered NOTHING for `waiting`, and for that status
// silence is the defining condition (the session emits no further turn until it is
// answered), so a stuck session was indistinguishable from one that went quiet.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { waitingFor, QUESTION, PERMISSION } = require('../lib/waiting-for');

test('a blocked session with a captured question is a question', () => {
  expect(waitingFor('waiting', true)).toBe(QUESTION);
});

test('a blocked session with nothing captured is a permission request', () => {
  // This is the Codex approval case as well as Claude's permission prompt: the
  // OSC 9 approval becomes a PermissionRequest through handleHook, so it lands
  // here with no captured question and needs no agent-specific branch.
  expect(waitingFor('waiting', false)).toBe(PERMISSION);
});

test('nothing else is ever waiting — null, so a client can render on truthiness', () => {
  for (const s of ['idle', 'working', 'active', 'compacting', '', null, undefined]) {
    expect(waitingFor(s, false), `status ${s}`).toBeNull();
    // A stale pendingQuestion must NOT resurrect the banner once the session
    // moved on — the status is what decides whether anything is blocked.
    expect(waitingFor(s, true), `status ${s} with stale question`).toBeNull();
  }
});

test('both session-shaping sites publish waitingFor', () => {
  // The regression this pins is a real, documented trap in this file: the cluster
  // merge shapes LOCAL rows field-by-field while spreading a peer's row whole, so
  // a field added only to /api/sessions shows a peer's blocked session and never
  // one of our own. `backgroundTasks` carries a comment saying exactly that.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const hits = src.split(/\r?\n/).filter((l) => /waitingFor:\s*sessionWaitingFor\(s\)/.test(l));
  expect(hits).toHaveLength(2);
});

test('the rule is imported, not reimplemented, in server.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  expect(src).toContain("require('./lib/waiting-for')");
  // No second copy of the decision anywhere in the server.
  //
  // Comments are stripped first. This guard is a text scan, so it cannot tell
  // code from prose — and SERVER_VERSION's changelog comment necessarily NAMES
  // the values it shipped ('question' / 'permission' / 'waiting'), which tripped
  // it on the very commit that introduced the rule. A guard that fires on its
  // own release note teaches people to ignore it.
  const inline = src.split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => /'waiting'/.test(l) && /'permission'|'question'/.test(l));
  expect(inline).toEqual([]);
});
