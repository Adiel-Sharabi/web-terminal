// @ts-check
// "Is a shell command actually running in this session?"
//
// The transcript badge (lib/background-tasks.js) only sees `run_in_background`
// launches. An ordinary tool call is invisible to it — measured on Office:
// session "sanity 147" reported `status=idle, backgroundTasks=[]` while a real
// `powershell.exe -NoProfile -NonInteractive` was alive under its agent. Only the
// process tree can see that.
//
// Every fixture below is a TRANSCRIPTION of a real tree sampled from adiel-0ffice
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
  { pid: 62040, ppid: 41304, name: 'node.exe' },      // MCP: am8-bridge
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
