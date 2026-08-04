// scripts/install-statusline.js — the machine-local Claude status-line install.
//
// TWO conditions have to hold for the ctx/token badges to work, and a machine where
// only one holds is SILENT rather than broken-looking (no line, no badge, nothing in
// a log). That is exactly how a box was found with a perfectly good server and no
// status line at all: settings.json had no `statusLine` entry, so Claude Code never
// ran the script, so nothing was ever pushed. These specs pin both halves.
//
// The installer is driven as a real child process against an isolated HOME, because
// the thing under test IS its filesystem effect on ~/.claude.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const INSTALLER = path.join(REPO, 'scripts', 'install-statusline.js');

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-statusline-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// --force skips the "is the server new enough" probe, which is about the SERVER's
// version and not about anything these specs assert.
// A script somewhere OTHER than ~/.claude/claude-status.sh, in both spellings:
// native for fs, POSIX for the command string a bash status line carries.
function foreignScript(home, name) {
  const native = path.join(home, '.claude', name);
  return {
    native,
    posix: native.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()),
  };
}

function runInstaller(home, args = []) {
  return execFileSync(process.execPath, [INSTALLER, '--force', ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    windowsHide: true,
  });
}

const readSettings = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const scriptPath = (home) => path.join(home, '.claude', 'claude-status.sh');

test.describe('install-statusline', () => {
  test('seeds a machine that has no status line at all', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ alwaysThinkingEnabled: true }));

    runInstaller(home);

    const sh = fs.readFileSync(scriptPath(home), 'utf8');
    // The whole point of the file: it forwards the payload to the repo-owned pusher.
    expect(sh).toContain('wt-push-status.sh');
    expect(sh).toContain('echo "$INPUT" | bash');

    // And Claude Code is actually told to run it — the half that was nobody's job.
    const s = readSettings(home);
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toContain('claude-status.sh');
    // Pre-existing settings survive.
    expect(s.alwaysThinkingEnabled).toBe(true);
  });

  test('a seeded script satisfies the patcher that will later maintain it', () => {
    // The seed is assembled around the same push block the patcher writes. If the two
    // ever drift, a re-run on a seeded machine would fail to find its own block and
    // bail out — this asserts the round trip instead of trusting it.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    runInstaller(home);
    const first = fs.readFileSync(scriptPath(home), 'utf8');

    const out = runInstaller(home);
    expect(out).toContain('already installed');
    // Idempotent: a second run must not rewrite the user's file.
    expect(fs.readFileSync(scriptPath(home), 'utf8')).toBe(first);
  });

  test('never overwrites a statusLine the user already chose', () => {
    // "Left alone" is the rule for the user's CHOICE of renderer. It is not, by
    // itself, a verdict that the machine is fine - see the two specs below.
    const home = makeHome();
    const own = foreignScript(home, 'my-line.sh');
    fs.writeFileSync(own.native, '#!/bin/bash\nINPUT=$(cat)\nSID=\"\"\n# wt-push-status.sh\necho hi\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${own.posix}` },
    }));

    const out = runInstaller(home);

    expect(readSettings(home).statusLine.command).toBe(`bash ${own.posix}`);
    expect(out).toContain('left alone');
  });

  test('the push block goes into the script the machine ACTUALLY runs', () => {
    // Our default path is a fallback, not the target. Seeding claude-status.sh
    // beside a statusLine that runs something else creates a file nothing runs -
    // the silent half-install this tool exists to detect, produced BY the tool,
    // and it used to exit 0 saying "Created".
    const home = makeHome();
    const own = foreignScript(home, 'other-line.sh');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${own.posix}` },
    }));

    const out = runInstaller(home);

    expect(fs.readFileSync(own.native, 'utf8')).toContain('wt-push-status.sh');
    expect(fs.existsSync(scriptPath(home))).toBe(false);   // no decoy
    expect(readSettings(home).statusLine.command).toBe(`bash ${own.posix}`);
    expect(out).toContain('left alone');
  });

  test('a tilde path is OUR script, not somebody else', () => {
    // `bash ~/.claude/claude-status.sh` is the form Claude Code's own docs use.
    // Compared unexpanded it equals nothing, so the machine's own status line
    // reads as foreign and a correctly configured box gets refused - and since
    // cold-restart.ps1 runs this every deploy, it would log a failure forever.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'bash ~/.claude/claude-status.sh' },
    }));

    const out = runInstaller(home);

    expect(fs.readFileSync(scriptPath(home), 'utf8')).toContain('wt-push-status.sh');
    expect(out).not.toContain('NOT ');
    expect(readSettings(home).statusLine.command).toBe('bash ~/.claude/claude-status.sh');
  });

  test('settings.local.json wins, because Claude Code resolves it first', () => {
    // A machine configured in settings.local.json looked UNCONFIGURED to a check
    // that read only settings.json: the installer added a statusLine that is
    // permanently overridden and then reported the machine fixed.
    const home = makeHome();
    const own = foreignScript(home, 'local-line.sh');
    fs.writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${own.posix}` },
    }));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    runInstaller(home);

    expect(fs.readFileSync(own.native, 'utf8')).toContain('wt-push-status.sh');
    // the overridden file must NOT have been "fixed"
    expect(readSettings(home).statusLine).toBeUndefined();
    expect(fs.existsSync(scriptPath(home))).toBe(false);
  });

  test('an unparseable settings.local.json is refused, not skipped', () => {
    // Asymmetry here was a false-green: the broken file OVERRIDES settings.json,
    // so writing a statusLine into settings.json and reporting success left the
    // machine pushing nothing.
    const home = makeHome();
    const local = path.join(home, '.claude', 'settings.local.json');
    fs.writeFileSync(local, '{ broken');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    let threw = false;
    let out = '';
    try { out = runInstaller(home); } catch (e) { threw = true; out = String(e.stdout) + String(e.stderr); }

    expect(threw).toBe(true);
    expect(out).toContain('settings.local.json');
    expect(readSettings(home).statusLine).toBeUndefined();
    expect(fs.readFileSync(local, 'utf8')).toBe('{ broken');
  });

  test('a status line we cannot identify is reported, never faked', () => {
    // npx / a .py renderer: nothing to patch and nowhere to put the block, so
    // the only honest answer is to say so. Writing our own script here would be
    // a decoy that nothing runs.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'npx ccstatusline' },
    }));

    let threw = false;
    let out = '';
    try { out = runInstaller(home); } catch (e) { threw = true; out = String(e.stdout) + String(e.stderr); }

    expect(threw).toBe(true);
    expect(out).toContain('ccstatusline');
    expect(out).toContain('wt-push-status.sh');   // tells you the line to add
    expect(fs.existsSync(scriptPath(home))).toBe(false);
  });

  test('refuses to rewrite a settings.json it cannot parse', () => {
    // That file is the user's entire Claude Code configuration. A parse error means we
    // do not understand it, which is the worst possible moment to write over it.
    const home = makeHome();
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{ this is not json');

    let threw = false;
    try { runInstaller(home); } catch (e) { threw = true; }

    expect(threw).toBe(true);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ this is not json');
    // The actual invariant: refuse to write a push block we cannot finish wiring
    // up. Without this line the spec stays green if that guard is removed.
    expect(fs.existsSync(scriptPath(home))).toBe(false);
  });

  test('--check reports both halves and changes nothing', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    const out = runInstaller(home, ['--check']);

    expect(out).toContain('Push block:');
    expect(out).toContain('Status line setting:');
    expect(fs.existsSync(scriptPath(home))).toBe(false);
    expect(readSettings(home).statusLine).toBeUndefined();
  });

  test('the seeded script renders the metrics and pushes the payload verbatim', () => {
    // Drives the real bash script with a real payload. This is the end-to-end shape
    // check that a unit test of the JS could not give: that the generated bash parses,
    // that the fields land in the right variables, and that stdout is the status line.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    runInstaller(home);

    const payload = JSON.stringify({
      session_id: '11111111-2222-3333-4444-555555555555',
      model: { display_name: 'Opus 4.8', id: 'claude-opus-4-8' },
      effort: { level: 'high' },
      context_window: { used_percentage: 37.4, context_window_size: 1000000 },
      rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 18 } },
    });

    let rendered;
    try {
      // WT_PORT points the pusher at a port nothing is listening on: the push is
      // fire-and-forget and must never affect the rendered line, which is the
      // contract wt-push-status.sh states ("always exits 0", "never writes stdout").
      rendered = execFileSync('bash', [scriptPath(home)], {
        input: payload,
        env: { ...process.env, HOME: home, USERPROFILE: home, WT_PORT: '1' },
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (e) {
      test.skip(true, 'bash not available on this machine');
      return;
    }

    expect(rendered).toContain('Opus 4.8');
    expect(rendered).toContain('high');
    expect(rendered).toContain('ctx 37%');
    expect(rendered).toContain('5h 42%');
    expect(rendered).toContain('7d 18%');
    // A stray newline or a debug echo would corrupt Claude's status line.
    expect(rendered).not.toContain('\n');
  });

  test('an ABSENT field does not shift every later one left', () => {
    // The render test above populates every field, which is precisely the one
    // shape that cannot catch this. A tab is IFS WHITESPACE: bash collapses runs
    // of it and drops leading/trailing ones, so `read` with IFS=$'	' silently
    // closes the gap and hands ctx's variable the 5h number, 5h's the 7d number,
    // and leaves 7d empty. The line then reads "ctx 42%" when ctx is UNKNOWN and
    // 42 is the five-hour figure -- a confidently wrong number, which is worse
    // than a missing one.
    //
    // Not an exotic payload: lib/metrics-claude.js documents used_percentage as
    // nullable, and a just-compacted session sends exactly this until its next
    // API call.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    runInstaller(home);

    const payload = JSON.stringify({
      session_id: '11111111-2222-3333-4444-555555555555',
      model: { display_name: 'Opus 4.8', id: 'claude-opus-4-8' },
      effort: { level: 'high' },
      context_window: { used_percentage: null, context_window_size: 1000000 },
      rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 18 } },
    });

    let rendered;
    try {
      rendered = execFileSync('bash', [scriptPath(home)], {
        input: payload,
        env: { ...process.env, HOME: home, USERPROFILE: home, WT_PORT: '1' },
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (e) {
      test.skip(true, 'bash not available on this machine');
      return;
    }

    // The two known numbers keep their own labels...
    expect(rendered).toContain('5h 42%');
    expect(rendered).toContain('7d 18%');
    // ...and the unknown one renders as nothing at all, never as another
    // window's figure wearing its label.
    expect(rendered).not.toContain('ctx');
    expect(rendered).toContain('Opus 4.8');
  });

  test('an empty or unparseable payload still renders a line and never errors', () => {
    // set -u plus an unparseable payload is how a status line breaks into a stack
    // trace on screen. Claude pipes a blank payload before the first API call.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    runInstaller(home);

    let rendered;
    try {
      rendered = execFileSync('bash', [scriptPath(home)], {
        input: 'not json at all',
        env: { ...process.env, HOME: home, USERPROFILE: home, WT_PORT: '1' },
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (e) {
      test.skip(true, 'bash not available on this machine');
      return;
    }

    expect(rendered).not.toContain('%');
    expect(rendered.length).toBeGreaterThan(0);
  });
});
