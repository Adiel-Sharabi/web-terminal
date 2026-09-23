// `GET /api/sessions` must stay PHASE-TIMED — asserted against the SOURCE.
//
// The same shape as tests/app-input-path.spec.js, tests/legacy-route-redirect.spec.js
// and tests/issue264-config-write-paths.spec.js, and for the same reason: no
// behavioural test can see this. The timing changes no response, emits nothing
// below a 5s threshold, and a refactor that dropped it would leave every other
// spec in this suite green while quietly removing the only thing that can say
// WHICH phase of this route was slow.
//
// That mattered on 2026-09-22: the route sat at 17-28s on a cluster peer while
// /api/version answered in 20ms, and nothing in any log could tell the worker
// RPC apart from the process-tree snapshot that spawns a PowerShell. Naming the
// responsible phase IS the diagnosis.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Normalised to LF. server.js is CRLF in this repo, so a `\n`-shaped slice
// finds nothing, `indexOf` returns -1, and `slice(0, -1 + 3)` quietly yields a
// two-character string that contains none of the things asserted below — a
// whole spec passing or failing on the line endings rather than the code. The
// first draft of this file did exactly that.
const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .split('\r\n')
  .join('\n');

/** The body of `app.get('/api/sessions', ...)`, up to the next route. */
function sessionsHandler() {
  const start = SRC.indexOf("app.get('/api/sessions', async (req, res)");
  expect(start, 'the /api/sessions route must exist').toBeGreaterThan(-1);
  const next = SRC.indexOf('\napp.', start + 10);
  expect(next, 'the route must be followed by another one').toBeGreaterThan(start);
  return SRC.slice(start, next);
}

/** The body of a top-level `function <name>(...) { ... }`. */
function functionBody(name) {
  const start = SRC.indexOf('function ' + name);
  expect(start, name + ' must exist').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}\n', start);
  expect(end, name + ' must be a closed top-level function').toBeGreaterThan(start);
  return SRC.slice(start, end + 3);
}

test.describe('#275 /api/sessions stays phase-timed', () => {
  test('the handler measures all four phases and reports them', () => {
    const body = sessionsHandler();
    // Each phase is named on the way to the log; losing one silently turns
    // "which phase was slow" back into "something was slow".
    for (const phase of ['rpc:', 'metrics:', 'convIds:', 'runningWork:']) {
      expect(body, `phase ${phase} must be measured`).toContain(phase);
    }
    expect(body).toContain('_logSlowSessions(');
    // Four boundaries plus the start = five readings. Fewer means two phases
    // got folded together and one of them can no longer be blamed.
    const marks = body.match(/performance\.now\(\)/g) || [];
    expect(marks.length, 'five timing marks bound four phases').toBe(5);
  });

  test('the reporter is wired to the PURE rule, not a re-implementation', () => {
    // lib/slow-log.js is where the threshold and the throttle are tested. A
    // local copy here would keep tests/slow-log.spec.js green while shipping
    // something else entirely.
    expect(SRC).toContain("require('./lib/slow-log')");
    const body = functionBody('_logSlowSessions');
    expect(body).toContain('slowLog.shouldLogSlow(');
    expect(body).toContain('slowLog.formatSlowPhases(');
  });

  test('the log line carries no session names, cwds or ids', () => {
    // It goes to a shared, rotated log on every box in the cluster. The phases
    // object is built from four numbers and nothing else; this pins that.
    const body = sessionsHandler();
    const call = body.slice(body.indexOf('_logSlowSessions('));
    const argsEnd = call.indexOf('}, ');
    expect(argsEnd, 'the _logSlowSessions call must pass a phases object').toBeGreaterThan(0);
    const args = call.slice(0, argsEnd + 3);
    for (const leak of ['s.name', 's.cwd', 's.id', 'list.map', 'JSON.stringify']) {
      expect(args, `the log arguments must not reference ${leak}`).not.toContain(leak);
    }
  });
});
