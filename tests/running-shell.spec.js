// @ts-check
// "Is a shell command actually running in this session?"
//
// The transcript badge (lib/background-tasks.js) only sees `run_in_background`
// launches. An ordinary tool call is invisible to it — measured on Office:
// session "sanity 147" reported `status=idle, backgroundTasks=[]` while a real
// `powershell.exe -NoProfile -NonInteractive` was alive under its agent. Only the
// process tree can see that.
//
// Every fixture below is a TRANSCRIPTION of a real tree sampled from a live server
// on 2026-07-29, including the two sessions that had nothing running — those are
// what make the discriminator ("a shell BELOW the agent") trustworthy rather than
// merely plausible, because they prove MCP servers never look like work.
const { test, expect } = require('@playwright/test');
const { runningShellsUnder, descendantsOf } = require('../lib/process-tree');

// --- real trees, pid/ppid/name exactly as sampled -------------------------------

/** "sanity 147" — a powershell WAS running under the agent. */
const SANITY_147 = [
  { pid: 57996, ppid: 1, name: 'conhost.exe' }, // the PTY root
  { pid: 57676, ppid: 57996, name: 'bash.exe' },
  { pid: 57548, ppid: 57676, name: 'bash.exe' },
  { pid: 41304, ppid: 57548, name: 'claude.exe' },
  { pid: 52192, ppid: 41304, name: 'node.exe' },      // MCP: MSSQLMCP_DBA
  { pid: 60716, ppid: 41304, name: 'node.exe' },      // MCP: azure-devops
  { pid: 50416, ppid: 41304, name: 'memory.exe' },    // MCP: memory server
  { pid: 62040, ppid: 41304, name: 'node.exe' },      // MCP: acme-bridge
  { pid: 66316, ppid: 41304, name: 'powershell.exe' }, // *** the running command
  { pid: 16316, ppid: 52192, name: 'conhost.exe' },
  { pid: 23344, ppid: 50416, name: 'python.exe' },    // MCP: mcp-memory-service
  { pid: 18584, ppid: 23344, name: 'python.exe' },
];

/** "combi" — same shape, nothing running. */
const COMBI = [
  { pid: 51832, ppid: 1, name: 'conhost.exe' },
  { pid: 17868, ppid: 51832, name: 'bash.exe' },
  { pid: 30316, ppid: 17868, name: 'bash.exe' },
  { pid: 13920, ppid: 30316, name: 'claude.exe' },
  { pid: 12424, ppid: 13920, name: 'node.exe' },
  { pid: 26856, ppid: 13920, name: 'node.exe' },
  { pid: 30812, ppid: 13920, name: 'memory.exe' },
  { pid: 49204, ppid: 12424, name: 'conhost.exe' },
  { pid: 45272, ppid: 30812, name: 'python.exe' },
  { pid: 17988, ppid: 45272, name: 'python.exe' },
];

test.describe('runningShellsUnder — a shell BELOW the agent is a running command', () => {
  test('the real "sanity 147" tree reports its powershell', () => {
    const running = runningShellsUnder(SANITY_147, 57996);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ pid: 66316, name: 'powershell.exe' });
  });

  test('a session with only MCP servers reports nothing (the control case)', () => {
    // node / memory.exe / python are present in EVERY Claude session. If these
    // counted, every session would claim to be busy forever.
    expect(runningShellsUnder(COMBI, 51832)).toEqual([]);
  });

  test('the PTY login-shell chain above the agent is never work', () => {
    // bash -> bash -> claude: two shells, both ABOVE the agent. Reporting them
    // would mark every session busy for its own existence.
    const running = runningShellsUnder(COMBI, 51832);
    expect(running.map((s) => s.pid)).not.toContain(17868);
    expect(running.map((s) => s.pid)).not.toContain(30316);
  });

  test('a shell spawned BY the command is one command, not two', () => {
    const tree = [
      ...COMBI,
      { pid: 900, ppid: 13920, name: 'powershell.exe' }, // the command
      { pid: 901, ppid: 900, name: 'cmd.exe' },          // spawned by it
      { pid: 902, ppid: 901, name: 'bash.exe' },         // and by that
    ];
    const running = runningShellsUnder(tree, 51832);
    expect(running.map((s) => s.pid)).toEqual([900]);
  });

  test('a build tool under the command needs no allowlist — the shell carries it', () => {
    const tree = [
      ...COMBI,
      { pid: 910, ppid: 13920, name: 'powershell.exe' },
      { pid: 911, ppid: 910, name: 'MSBuild.exe' },
      { pid: 912, ppid: 911, name: 'cl.exe' },
    ];
    expect(runningShellsUnder(tree, 51832).map((s) => s.name)).toEqual(['powershell.exe']);
  });

  test('two concurrent commands are both reported', () => {
    const tree = [
      ...COMBI,
      { pid: 920, ppid: 13920, name: 'powershell.exe' },
      { pid: 921, ppid: 13920, name: 'cmd.exe' },
    ];
    expect(runningShellsUnder(tree, 51832).map((s) => s.pid).sort()).toEqual([920, 921]);
  });

  test('a session with NO agent reports nothing', () => {
    // A plain shell session has no "beside the agent" baseline, so the same rule
    // would report the user's own interactive shell as work. Silence is correct.
    const plain = [
      { pid: 100, ppid: 1, name: 'conhost.exe' },
      { pid: 101, ppid: 100, name: 'bash.exe' },
      { pid: 102, ppid: 101, name: 'powershell.exe' },
    ];
    expect(runningShellsUnder(plain, 100)).toEqual([]);
  });

  test('a Codex session is covered by the same rule — no per-agent branch', () => {
    const codex = [
      { pid: 200, ppid: 1, name: 'conhost.exe' },
      { pid: 201, ppid: 200, name: 'bash.exe' },
      { pid: 202, ppid: 201, name: 'codex.exe' },
      { pid: 203, ppid: 202, name: 'powershell.exe' },
    ];
    expect(runningShellsUnder(codex, 200).map((s) => s.pid)).toEqual([203]);
  });

  test('garbage in does not throw', () => {
    expect(runningShellsUnder(null, 1)).toEqual([]);
    // @ts-expect-error — deliberately abusive
    expect(runningShellsUnder(SANITY_147, undefined)).toEqual([]);
    expect(runningShellsUnder([], 57996)).toEqual([]);
  });

  test('a cyclic parent chain cannot hang the session list', () => {
    // Windows reuses pids and can leave a dangling ParentProcessId; the walk must
    // terminate. descendantsOf already guarantees this — pin it here too.
    const cyclic = [
      { pid: 300, ppid: 301, name: 'bash.exe' },
      { pid: 301, ppid: 300, name: 'claude.exe' },
    ];
    expect(() => descendantsOf(cyclic, 300)).not.toThrow();
    expect(() => runningShellsUnder(cyclic, 300)).not.toThrow();
  });
});

// --- #411: an npx-launched MCP server is a cmd.exe under the agent ------------------------
//
// The premise above ("MCP servers are node/python beside the agent, never a shell") is
// false for a server whose command is a .cmd shim (npx): Claude's MCP transport spawns it
// through cross-spawn as `<comspec> /d /s /c "<cmd> ^"arg^" ..."`. Transcribed from a live
// tree on adiel-xps, 2026-11-05, Claude Code 2.1.318 - the firebase PLUGIN's MCP server,
// started 2.8 s after its agent and alive for 4 days. npx spawns a SECOND cmd.exe below
// it, so dropping only the outer shell would surface the inner one as "work".
const { mcpLaunchFor } = require('../lib/agents');

const MCP_NPX_LINE = 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"firebase-tools@latest^" ^"mcp^" ^"--only^" ^"core^,crashlytics^""';
// Claude's own PowerShell TOOL is also a `cmd.exe /d /s /c` child of the agent (captured from
// a live tool call, same version, truncated after the launcher). It is a command, not a server.
const PS_TOOL_LINE = 'C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT""';

const BIND_DEVICE = [
  { pid: 5000, ppid: 1, name: 'conhost.exe' },
  { pid: 5001, ppid: 5000, name: 'bash.exe', cmd: '/usr/bin/bash --login -i' },
  { pid: 28188, ppid: 5001, name: 'claude.exe' },
  { pid: 37424, ppid: 28188, name: 'cmd.exe', cmd: MCP_NPX_LINE },
  { pid: 25156, ppid: 37424, name: 'conhost.exe' },
  { pid: 26760, ppid: 37424, name: 'node.exe' },
  { pid: 24432, ppid: 26760, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c firebase mcp --only core,crashlytics' },
  { pid: 32524, ppid: 24432, name: 'node.exe' },
];
const CLAUDE_MCP = mcpLaunchFor('claude');

test.describe('#411 an MCP server launched through a shell is not running work', () => {
  test('the real npx MCP tree reports NOTHING - neither the outer nor the inner cmd.exe', () => {
    expect(runningShellsUnder(BIND_DEVICE, 5000, CLAUDE_MCP)).toEqual([]);
  });

  test('without the agent\'s declared shape the old answer stands (the bug, pinned)', () => {
    // No declaration = today's rule: a shell under the agent is work. Fails toward "busy".
    expect(runningShellsUnder(BIND_DEVICE, 5000).map((s) => s.pid)).toEqual([37424]);
  });

  test('Claude\'s PowerShell tool (cmd.exe /d /s /c ""chcp ...) is still a command', () => {
    const tree = [...BIND_DEVICE, { pid: 940, ppid: 28188, name: 'cmd.exe', cmd: PS_TOOL_LINE },
      { pid: 941, ppid: 940, name: 'powershell.exe' }];
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([940]);
  });

  test('a plain `cmd.exe /c npm test` under the agent is still a command', () => {
    const tree = [...BIND_DEVICE, { pid: 950, ppid: 28188, name: 'cmd.exe', cmd: 'cmd.exe /c npm test' }];
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([950]);
  });

  test('the shape only counts DIRECTLY under the agent - anywhere else it is not trusted', () => {
    // The agent's MCP transport is the only thing known to launch this shape, and it is the
    // agent's own child. The same line below some other process (here a node helper) is not
    // vouched for, so it stays work - the error that keeps a build alive.
    const tree = [...BIND_DEVICE,
      { pid: 960, ppid: 28188, name: 'node.exe' },
      { pid: 961, ppid: 960, name: 'cmd.exe', cmd: MCP_NPX_LINE }];
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([961]);
  });

  test('a shell whose command line could not be read is still work (fail toward busy)', () => {
    const tree = BIND_DEVICE.map((p) => (p.pid === 37424 ? { ...p, cmd: null } : p));
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([37424]);
  });

  test('a real command beside the MCP server is reported, the server is not', () => {
    const tree = [...BIND_DEVICE, { pid: 970, ppid: 28188, name: 'bash.exe', cmd: 'bash -c "dotnet test"' }];
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([970]);
  });

  test('what an on-demand MCP server RUNS is still work - only its launcher chain is not', () => {
    // A command-running MCP server started through npx: its launcher (37424) and npx's hop
    // (24432) are not work, but a build it starts for a tool call is, exactly as it would
    // be under a server launched as plain node.
    const tree = [...BIND_DEVICE,
      { pid: 980, ppid: 32524, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "dotnet build"' },
      { pid: 981, ppid: 980, name: 'dotnet.exe' }];
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([980]);
  });

  test('under a NON-runner .cmd (a global shim) the node below IS the server - its build is work', () => {
    // Final-gate finding: the hop rule must not fire for any .cmd. A globally installed
    // server's shim starts the server node directly, so a shell under that node is a
    // tool's command, exactly as under a server launched as plain node.
    const tree = [
      { pid: 6000, ppid: 1, name: 'conhost.exe' },
      { pid: 6001, ppid: 6000, name: 'bash.exe', cmd: 'bash' },
      { pid: 6002, ppid: 6001, name: 'claude.exe' },
      { pid: 6003, ppid: 6002, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "desktop-commander ^"--no-onboarding^""' },
      { pid: 6004, ppid: 6003, name: 'node.exe' },
      { pid: 6005, ppid: 6004, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "dotnet build big.sln"' },
      { pid: 6006, ppid: 6005, name: 'dotnet.exe' },
    ];
    expect(runningShellsUnder(tree, 6000, CLAUDE_MCP).map((s) => s.pid)).toEqual([6005]);
    const { liveWorkUnder } = require('../lib/process-tree');
    expect(liveWorkUnder(tree, 6000, CLAUDE_MCP).map((s) => s.pid)).toEqual([6005]);
  });

  test('a runner named by full, escaped path (C:\\Program^ Files\\nodejs\\npx.cmd) still gets its hop', () => {
    const tree = BIND_DEVICE.map((p) => (p.pid === 37424
      ? { ...p, cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"firebase-tools@latest^" ^"mcp^""' }
      : p));
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP)).toEqual([]);
  });

  test('the hop only under a NODE runner child - another image below the launcher is not npx', () => {
    const tree = BIND_DEVICE.map((p) => (p.pid === 26760 ? { ...p, name: 'python.exe' } : p));
    expect(runningShellsUnder(tree, 5000, CLAUDE_MCP).map((s) => s.pid)).toEqual([24432]);
  });

  test('two agents in one tree, and a /g pattern, are each judged on their own rows', () => {
    // A stateful (/g) RegExp keeps lastIndex between test() calls; without the reset the
    // second matching row would be tested from the wrong offset and read as work.
    const tree = [...BIND_DEVICE,
      { pid: 990, ppid: 5001, name: 'claude.exe' },
      { pid: 991, ppid: 990, name: 'cmd.exe', cmd: MCP_NPX_LINE },
      { pid: 993, ppid: 991, name: 'node.exe' },
      { pid: 994, ppid: 993, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c firebase mcp' },
      { pid: 992, ppid: 990, name: 'powershell.exe', cmd: 'powershell.exe -NoProfile' }];
    const opts = {
      mcpServerShell: new RegExp(CLAUDE_MCP.mcpServerShell.source, 'gi'),
      mcpPackageRunner: new RegExp(CLAUDE_MCP.mcpPackageRunner.source, 'gi'),
    };
    expect(runningShellsUnder(tree, 5000, opts).map((s) => s.pid)).toEqual([992]);
  });

  test('server.js passes the agent\'s shape at EVERY call site (dropping it is silent)', () => {
    // Without the option the rule falls back to "busy", so no behaviour test would notice
    // a call site that forgot it. Gate the source instead.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const calls = src.match(/processTree\.(?:runningShellsUnder|liveWorkUnder)\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toContain('mcpLaunchFor(s.agent)');
  });

  test('liveWorkUnder (the reaper and the restart hold) takes the same rule', () => {
    const { liveWorkUnder } = require('../lib/process-tree');
    expect(liveWorkUnder(BIND_DEVICE, 5000, CLAUDE_MCP)).toEqual([]);
    expect(liveWorkUnder(BIND_DEVICE, 5000).map((s) => s.pid)).toEqual([37424]);
  });
});

test.describe('#411 mcpLaunchFor - the launch shape lives in the agent registry', () => {
  const re = mcpLaunchFor('claude').mcpServerShell;
  test('Claude declares it; Codex, a plain shell and unknown ids do not', () => {
    expect(re).toBeInstanceOf(RegExp);
    expect(mcpLaunchFor('claude').mcpPackageRunner).toBeInstanceOf(RegExp);
    expect(mcpLaunchFor('codex')).toEqual({});
    expect(mcpLaunchFor(null)).toEqual({});
    expect(mcpLaunchFor('nope')).toEqual({});
  });
  test('the package runners are named exactly - a server shim is not one', () => {
    const r = mcpLaunchFor('claude').mcpPackageRunner;
    for (const ok of ['npx', 'npx.cmd', 'NPX.CMD', 'npm', 'pnpm.cmd', 'pnpx', 'yarn', 'bunx']) expect(r.test(ok), ok).toBe(true);
    for (const no of ['desktop-commander', 'npx-server', 'mynpx.cmd', 'node', '']) expect(r.test(no), no).toBe(false);
  });
  test('matches the cross-spawn launch, including a quoted comspec and a spaced shim path', () => {
    expect(re.test(MCP_NPX_LINE)).toBe(true);
    expect(re.test('"C:\\Windows\\system32\\cmd.exe" /d /s /c "C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"@scope/srv^""')).toBe(true);
    // A cmd-shim under node_modules/.bin is DOUBLE-escaped by cross-spawn.
    expect(re.test('cmd.exe /d /s /c "srv.cmd ^^^"--port^^^" ^^^"1^^^""')).toBe(true);
  });
  test('does NOT match a command', () => {
    expect(re.test(PS_TOOL_LINE)).toBe(false);
    expect(re.test('cmd.exe /c npm test')).toBe(false);
    expect(re.test('C:\\WINDOWS\\system32\\cmd.exe /d /s /c firebase mcp --only core,crashlytics')).toBe(false);
    expect(re.test('cmd.exe /d /s /c "npm test"')).toBe(false);
    expect(re.test('cmd.exe /d /s /c "npx ^"-y^" ^"x^"" & del important')).toBe(false);
    // cross-spawn escapes every cmd metacharacter; an UNESCAPED & is a second command.
    expect(re.test('cmd.exe /d /s /c "x ^"a^" & msbuild big.sln ^"b^""')).toBe(false);
    expect(re.test('cmd.exe /d /s /c "x ^"a b^""')).toBe(false);
    expect(re.test('')).toBe(false);
  });
  test('a long non-matching line is rejected in linear time', () => {
    const evil = 'cmd.exe /d /s /c "npx ' + '^"a^" '.repeat(5000) + '^"b';
    const t0 = Date.now();
    expect(re.test(evil)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
