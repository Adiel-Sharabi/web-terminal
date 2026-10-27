#!/usr/bin/env node
// #400 probe - does the companion keep the keyboard's height after the keyboard
// has gone? (Flutter engine stale IME inset, flutter/flutter#191156.)
//
// Real device only: the bug is a race between the IME animation and the
// activity going to the background, which no widget test or emulator-free run
// can produce. Measured on Android 17: Home ~50 ms after focusing the compose
// bar leaves every screen short by the keyboard height until a relaunch.
//
// Precondition: the companion is in the foreground on a SESSION screen (its
// compose bar is the bottom-most text field), keyboard hidden. The probe first
// records where the bar sits at rest (the BASELINE). For each delay it then taps
// the bar, presses Home after that delay, relaunches the app, and reads, from
// the platform and never from the app's pixels:
//   - Android's IME state (`dumpsys input_method` mInputShown);
//   - where the bar sits (`uiautomator dump`, the bottom-most EditText).
// STUCK = no keyboard on screen, yet the bar is not back at its baseline. That
// catches the keyboard-height gap and any smaller one (a nav-bar-sized band).
// An attempt with the keyboard up proves nothing: INCONCLUSIVE.
// Any setup failure ABORTS - the probe never reports a negative it did not see.
//
// usage: node scripts/rig/probe-ime-inset-android.js <adb-serial> [delayMs ...]
// exit:  0 every attempt OK, 1 any attempt STUCK, 2 setup failure or nothing
//        conclusive measured.

'use strict';
const { execFileSync } = require('child_process');

const PKG = 'net.hilashnet.aiTerminal';
const DUMP = '/sdcard/wt-ime-probe.xml';
// A bar further than this from its baseline with no keyboard shown is laid out
// above space that is not there. Well below a nav bar (~126 px on 3-button).
const TOLERANCE_PX = 40;
// The baseline itself must be near the bottom, or the screen is already stuck.
const MAX_BASELINE_GAP_PX = 400;

const [serial, ...delayArgs] = process.argv.slice(2);
if (!serial) {
  console.error('usage: probe-ime-inset-android.js <adb-serial> [delayMs ...]');
  process.exit(2);
}
const delays = delayArgs.length ? delayArgs.map(Number) : [50, 100, 200];

function adb(...args) {
  // MSYS_NO_PATHCONV: Git Bash would otherwise rewrite /sdcard into a Windows path.
  return execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], // monkey narrates its args on stderr
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function imeShown() {
  const m = /mInputShown=(true|false)/.exec(adb('shell', 'dumpsys', 'input_method'));
  if (!m) throw new Error('dumpsys input_method reports no mInputShown');
  return m[1] === 'true';
}

function isForeground() {
  const m = /topResumedActivity=\S+ \S+ (\S+)\//.exec(adb('shell', 'dumpsys', 'activity', 'activities'));
  return !!m && m[1] === PKG;
}

// A FRESH dump: the old file is removed first and the write must be confirmed,
// so a dump that failed (e.g. "could not get idle state") cannot replay the
// previous screen. Returns the window height (the hierarchy root, so it follows
// the current orientation) and the bottom-most EditText of the app.
function readScreen() {
  adb('shell', 'rm', '-f', DUMP);
  const out = adb('shell', 'uiautomator', 'dump', DUMP);
  if (!/dumped to/i.test(out)) throw new Error(`uiautomator dump failed: ${out.trim()}`);
  const xml = adb('shell', 'cat', DUMP);
  let height = 0;
  let bar = null;
  for (const node of xml.split('<node ')) {
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!b) continue;
    const r = b.slice(1).map(Number);
    height = Math.max(height, r[3]);
    if (!node.includes('class="android.widget.EditText"')) continue;
    if (!node.includes(`package="${PKG}"`)) continue;
    if (!bar || r[3] > bar[3]) bar = r;
  }
  if (!height) throw new Error('screen dump has no bounds');
  return { height, bar };
}

function restingGap() {
  if (!isForeground()) throw new Error(`${PKG} is not in the foreground`);
  if (imeShown()) throw new Error('keyboard is up - start from a session with it hidden');
  const { height, bar } = readScreen();
  if (!bar) throw new Error('no compose bar on screen - open a session first');
  const gap = height - bar[3];
  if (gap > MAX_BASELINE_GAP_PX) {
    throw new Error(`bar already ${gap}px above the bottom with no keyboard - relaunch the app first`);
  }
  return { gap, bar };
}

async function attempt(delayMs, baseline) {
  const { bar } = restingGap();
  const x = Math.round((bar[0] + bar[2]) / 2);
  const y = Math.round((bar[1] + bar[3]) / 2);
  adb('shell', 'input', 'tap', String(x), String(y));
  await sleep(delayMs);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(2000);
  adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1');
  await sleep(3000);
  // Another adb client can bring its own app forward mid-run (seen: a second
  // session deploying to the same phone); judging that screen would be noise.
  if (!isForeground()) throw new Error(`${PKG} is not in the foreground after relaunch`);
  const ime = imeShown();
  const { height, bar: after } = readScreen();
  if (!after) throw new Error('compose bar gone after relaunch - cannot judge');
  const gap = height - after[3];
  let verdict;
  if (ime) verdict = 'INCONCLUSIVE';
  else verdict = Math.abs(gap - baseline) > TOLERANCE_PX ? 'STUCK' : 'OK';
  console.log(`delay ${delayMs} ms: keyboard ${ime ? 'shown' : 'hidden'}, ` +
    `bar gap ${gap}px (baseline ${baseline}px) -> ${verdict}`);
  if (ime) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(800);
  }
  return verdict;
}

(async () => {
  const verdicts = [];
  try {
    adb('get-state');
    const { gap: baseline } = restingGap();
    console.log(`baseline: bar ${baseline}px above the bottom, keyboard hidden`);
    for (const d of delays) {
      const v = await attempt(d, baseline);
      verdicts.push(v);
      // A stuck screen stays stuck; the next attempt's resting check would abort.
      if (v === 'STUCK') break;
    }
  } catch (e) {
    console.error(`ABORT: ${e.message}`);
    process.exit(2);
  }
  if (verdicts.includes('STUCK')) process.exit(1);
  process.exit(verdicts.includes('OK') ? 0 : 2);
})();
