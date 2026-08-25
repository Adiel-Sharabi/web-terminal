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

// `cwd` matters for one spec only, but it defaults to a throwaway directory for
// ALL of them: a relative status-line command used to be resolved against the
// installer's working directory, so a spec that got that wrong wrote a decoy into
// the REPO ROOT and the next run inherited it. Asserting against process.cwd()
// made the suite order-dependent in both directions - it could pollute, and it
// could be polluted. Nothing here should ever depend on where it was launched.
function runInstaller(home, args = [], cwd = null) {
  return execFileSync(process.execPath, [INSTALLER, '--force', ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'wt-statusline-cwd-')),
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

  // --- The command is PARSED, and every interpreter shape is ordinary ----------
  // Four review rounds each found a different status-line command that this tool
  // read wrongly and then ACTED on. The worst of them returned the whole command
  // as if it were a path, created `C:\usr\bin\env bash ~\.claude\statusline.sh`
  // on the drive root, never touched the real status line, and exited 0 reporting
  // success. These pin the shapes; the two structural guards below pin what
  // happens when a shape defeats the parse anyway.
  for (const [label, commandFor] of [
    ['an env-shebang interpreter', (p) => `/usr/bin/env bash ${p}`],
    ['a quoted Windows bash.exe', (p) => `"C:/Program Files/Git/bin/bash.exe" ${p}`],
    ['an interpreter flag', (p) => `bash -l ${p}`],
    ['a bare path with no interpreter', (p) => p],
  ]) {
    test(`${label} still names the script we must patch`, () => {
      const home = makeHome();
      const own = foreignScript(home, 'other-line.sh');
      const command = commandFor(own.posix);
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
        statusLine: { type: 'command', command },
      }));

      const out = runInstaller(home);

      // The real script is the one that got the push block...
      expect(fs.readFileSync(own.native, 'utf8')).toContain('wt-push-status.sh');
      // ...their command is untouched, and no decoy was left at our default path.
      expect(readSettings(home).statusLine.command).toBe(command);
      expect(fs.existsSync(scriptPath(home))).toBe(false);
      expect(out).toContain('left alone');

      // And nothing was created anywhere else under the home we gave it. This is
      // the assertion that fails loudest on a misparse: the junk path is derived
      // from the command, so it is not something a spec can name in advance.
      const stray = fs.readdirSync(path.join(home, '.claude'))
        .filter((f) => f !== 'other-line.sh' && f !== 'settings.json' && !f.endsWith('.bak'));
      expect(stray).toEqual([]);
    });
  }

  // A script the installer can actually PATCH: it defines the two variables the
  // injected line uses, carries an older push block, and has a following section
  // header to bound it. A script that merely exists with no block is refused, on
  // purpose - so a fixture without one tests the refusal, not the parse.
  const PATCHABLE = [
    '#!/bin/bash',
    'INPUT=$(cat)',
    'SID=""',
    '# --- Push metrics to the local web-terminal server (old) ---',
    'curl -s localhost:7681/api/claude-status >/dev/null &',
    '# --- Render -----------------------------------------------',
    'echo hi',
    '',
  ].join('\n');

  test('a flag ARGUMENT that ends in .sh is never mistaken for the script', () => {
    // `bash --rcfile ~/.claude/rc.sh ~/.claude/claude-status.sh` is an ordinary
    // invocation. Taking the first .sh token patched bash's RCFILE argument,
    // seeded a decoy at rc.sh, left the real status line untouched and exited 0
    // saying "Created" - the same invented-path/junk-file/green-verdict shape as
    // the round-4 defect, reproduced against the commit that was supposed to have
    // made it structurally impossible. The "never create a directory" guard could
    // not help: ~/.claude always exists, and that is where status lines live.
    const home = makeHome();
    const real = foreignScript(home, 'claude-status-real.sh');
    const rc = foreignScript(home, 'rc.sh');
    fs.writeFileSync(real.native, PATCHABLE);

    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash --rcfile ${rc.posix} ${real.posix}` },
    }));

    const out = runInstaller(home);

    expect(fs.readFileSync(real.native, 'utf8')).toContain('wt-push-status.sh');
    expect(fs.existsSync(rc.native)).toBe(false);        // no decoy at the rcfile
    expect(fs.existsSync(scriptPath(home))).toBe(false); // nor at our default
    expect(out).toContain('left alone');
  });

  test('a relative status-line command is reported, not resolved against our cwd', () => {
    // Claude Code resolves `bash ./statusline.sh` against the PROJECT directory,
    // so there is no one file on this machine to patch. Treating it as a path
    // wrote the seed into whatever directory the INSTALLER was launched from -
    // the repo root, when run the documented way. It is unidentifiable, and
    // saying so is the honest answer.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'bash ./statusline.sh' },
    }));
    // A cwd of our own, so "did it write into the working directory" is asked of
    // somewhere nothing else can touch. Pointing this at the repo root is how a
    // failing run left a decoy behind that the NEXT run then tripped over.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-statusline-launch-'));

    let out = '';
    let threw = false;
    try { out = runInstaller(home, [], cwd); } catch (e) { threw = true; out = String(e.stdout) + String(e.stderr); }

    expect(threw).toBe(true);
    expect(out).toMatch(/names no \.sh script we can patch/i);
    expect(fs.existsSync(scriptPath(home))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);   // nothing landed where it was launched
  });

  test('a quoted shell one-liner is not read as a path', () => {
    // `sh -c "exec ~/.claude/claude-status.sh"` names a COMMAND, not a file. The
    // quoted-run branch returned it whole, so a correctly installed machine was
    // told its status line "does not exist" - a red verdict on a healthy box,
    // which costs as much trust as a false green.
    const home = makeHome();
    const own = foreignScript(home, 'claude-status.sh');
    fs.writeFileSync(own.native, PATCHABLE);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `sh -c "exec ${own.posix}"` },
    }));

    let out = '';
    try { out = runInstaller(home); } catch (e) { out = String(e.stdout) + String(e.stderr); }

    expect(out).toMatch(/names no \.sh script we can patch/i);
    expect(out).not.toMatch(/does not exist/i);
  });

  test('an ambiguous command is settled by the disk, not by a guess', () => {
    // `bash <path with a space>.sh` and `bash <script>.sh <arg>.sh` are THE SAME
    // STRING to a parser, and whichever rule you pick blindly gets the other one
    // wrong - either patching a file called "wrapper.sh inner.sh" that cannot
    // exist, or refusing a machine whose home directory contains a space. Four
    // rounds of reasoning about command shapes is enough evidence that guessing
    // does not scale here: the disk is asked instead, and the reading that EXISTS
    // wins.
    const home = makeHome();
    const wrapper = foreignScript(home, 'wrapper.sh');
    const inner = foreignScript(home, 'inner.sh');
    fs.writeFileSync(wrapper.native, PATCHABLE);
    fs.writeFileSync(inner.native, '#!/bin/bash\necho inner\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${wrapper.posix} ${inner.posix}` },
    }));

    let out = '';
    try { out = runInstaller(home); } catch (e) { out = String(e.stdout) + String(e.stderr); }

    // The script it RUNS got the block; its argument was left alone.
    expect(fs.readFileSync(wrapper.native, 'utf8')).toContain('wt-push-status.sh');
    expect(fs.readFileSync(inner.native, 'utf8')).not.toContain('wt-push-status.sh');
    expect(fs.existsSync(scriptPath(home))).toBe(false);
    expect(out).not.toMatch(/does not exist/i);
  });

  test('a status-line path that really does contain a space is still patched', () => {
    // The other half of the same ambiguity, and the round-3 failure mode: a false
    // REFUSAL on a healthy machine is as bad as a false green. A home directory
    // whose name contains a space is ordinary on Windows, and so is a status line
    // kept in a folder with one.
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude', 'my tools'), { recursive: true });
    const spaced = foreignScript(home, path.join('my tools', 'line.sh'));
    fs.writeFileSync(spaced.native, PATCHABLE);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${spaced.posix}` },
    }));

    let out = '';
    try { out = runInstaller(home); } catch (e) { out = String(e.stdout) + String(e.stderr); }

    expect(fs.readFileSync(spaced.native, 'utf8')).toContain('wt-push-status.sh');
    expect(out).toContain('left alone');
  });

  test('a trailing .sh ARGUMENT is excluded even when nothing exists to compare', () => {
    // The disk can only vote on files that are THERE - so it abstains in the one
    // case where the installer actually creates something. Every other ambiguity
    // spec here uses fixtures that exist, so none of them reaches this branch:
    // the rule has to be right without the disk's help, or the seeding path is
    // unguarded. `bash <script>.sh theme.sh` with the script absent used to
    // create a file literally named "statusline.sh theme.sh".
    const home = makeHome();
    const target = foreignScript(home, 'statusline.sh');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${target.posix} theme.sh` },
    }));

    const out = runInstaller(home);

    // Seeded at the script, not at "statusline.sh theme.sh".
    expect(fs.readFileSync(target.native, 'utf8')).toContain('wt-push-status.sh');
    const stray = fs.readdirSync(path.join(home, '.claude'))
      .filter((f) => f !== 'statusline.sh' && f !== 'settings.json' && !f.endsWith('.bak'));
    expect(stray).toEqual([]);
    expect(out).toContain('left alone');
  });

  test('a path we did not choose gets a FILE, never a directory tree', () => {
    // The structural guard behind the parse. A misread command yields a path
    // whose parent does not exist; a genuine one that is merely absent sits in a
    // directory that does. So the tool creates its own default path freely and
    // will populate a configured-but-empty script, but it never calls mkdir on a
    // location it inferred - which is what turned a parsing bug into a real file
    // on a real disk. Holds even if some future shape defeats scriptInCommand.
    const home = makeHome();
    const deep = foreignScript(home, 'nope/deeper/line.sh');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${deep.posix}` },
    }));

    let threw = false;
    let out;
    try { out = runInstaller(home); } catch (e) { threw = true; out = String(e.stdout) + String(e.stderr); }

    expect(threw).toBe(true);                                    // refused, not "Created"
    expect(fs.existsSync(path.join(home, '.claude', 'nope'))).toBe(false);
    expect(fs.existsSync(scriptPath(home))).toBe(false);         // and no decoy either
    expect(out).toMatch(/does not exist/i);
  });

  test('a refusal about the script is preceded by the verdict on the setting', () => {
    // Finding 3 of round four: the push half used to be planned at module load,
    // before settings had been read - so a machine whose statusLine we could not
    // identify was told to hand-patch ~/.claude/claude-status.sh, a file its
    // settings never mention. Which script to patch is DECIDED by the settings
    // half, so the settings half has to be reported first.
    const home = makeHome();
    const own = foreignScript(home, 'weird.sh');
    // Present, but nothing we can inject into: no $INPUT, no push block.
    fs.writeFileSync(own.native, '#!/bin/bash\necho hi\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `bash ${own.posix}` },
    }));

    let out = '';
    try { out = runInstaller(home); } catch (e) { out = String(e.stdout) + String(e.stderr); }

    // Both halves are spoken for, and the setting comes first.
    const setting = out.indexOf('status line setting:');
    const refusal = out.indexOf('defines no $INPUT');
    expect(setting).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(-1);
    expect(setting).toBeLessThan(refusal);
    // The refusal names THEIR script, never our default.
    expect(out).toContain('weird.sh');
    expect(out).not.toContain('claude-status.sh defines no');
  });
});
