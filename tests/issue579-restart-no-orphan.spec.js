// @ts-check
// #579 - POST /api/restart must let the SUPERVISOR restart the web, never start one itself.
//
// The route predated monitor.js: it ran `pm2 restart web-terminal` and, when that failed,
// spawned a detached copy of server.js before exiting 0. monitor.js restarts a web that
// exits 0, so two servers raced for the worker's single IPC slot (lib/ipc.js `_onSocket`
// refuses a second client). The orphan won; every monitor-started web crashed on EPIPE until
// the monitor's crash budget stopped it for good, and a later hot reload killed the orphan:
// every peer 502 (2026-11-26).
//
// Asserted on the source, like #218's redirect: calling the route would end the suite's
// shared server, and the suite's server does not run under monitor.js to bring it back.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function restartHandlerSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf("app.post('/api/restart'");
  expect(start, 'the /api/restart route exists').toBeGreaterThan(-1);
  // The handler ends at the first top-level `});` after the route opens.
  const end = src.indexOf('\n});', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Code only: a comment may name what the route must never do. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test.describe('#579 /api/restart leaves restarting to the monitor', () => {
  test('the handler starts no process: no spawn, no pm2, no detached child', () => {
    const code = stripComments(restartHandlerSource());
    expect(code).not.toMatch(/\bspawn\s*\(/);
    expect(code).not.toMatch(/\bfork\s*\(/);
    expect(code).not.toMatch(/pm2/i);
    expect(code).not.toMatch(/detached/);
  });

  test('the handler exits 0, which is what monitor.js restarts', () => {
    const code = stripComments(restartHandlerSource());
    expect(code).toMatch(/process\.exit\(\s*0\s*\)/);
    // The other half of the contract: the monitor respawns a clean exit.
    const monitor = fs.readFileSync(path.join(__dirname, '..', 'monitor.js'), 'utf8');
    expect(monitor).toMatch(/if \(code === 0\) \{[\s\S]{0,200}setTimeout\(spawnWeb/);
  });
});
