'use strict';
// --- The settings a session ran under (#529) ---------------------------------------------
//
// "Does a smaller context give BETTER results?" can only be answered if every session knows the
// regime it ran under. A `settings` record is written whenever one of these changes, and a session
// is joined to the newest record of its own machine at or before its start (lib/usage-quality.js).
// Read at each collect: Claude's own settings file (the auto-compact window, the effort, the default
// model) and the web-terminal config's `handoff` thresholds (primitive values only).

const fs = require('fs');
const path = require('path');

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x) => (typeof x === 'string' && x ? x.slice(0, 60) : null);

/** The current regime. [config] is the web-terminal config object (or null). */
function readSettings({ claudeDir, config, fsx = fs }) {
  let s = {};
  try { s = JSON.parse(fsx.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) || {}; } catch { /* none: all unknown */ }
  const handoff = {};
  const h = config && typeof config.handoff === 'object' && config.handoff ? config.handoff : {};
  for (const [k, v] of Object.entries(h).slice(0, 12)) if (typeof v === 'number' || typeof v === 'boolean') handoff[k.slice(0, 40)] = v;
  return { autoCompactWindow: num(s.autoCompactWindow), effort: str(s.effortLevel) || str(s.effort), defaultModel: str(s.model), handoff };
}

/** Do two regimes (a snapshot, or a stored record) say the same thing? */
function sameSettings(a, b) {
  if (!a || !b) return false;
  const pick = (x) => JSON.stringify([x.autoCompactWindow ?? null, x.effort ?? null, x.defaultModel ?? null, Object.entries(x.handoff || {}).sort()]);
  return pick(a) === pick(b);
}

/** The draft of a `settings` record taken at [at] (an ISO string, part of its key). */
function settingsDraft({ origin, at, snapshot }) {
  return { type: 'settings', key: `${origin}|settings|${at}`, settingsAt: at, ...snapshot };
}

/** A short label for a regime, e.g. `400k ctx / xhigh / opus[1m] / hand-off 200k`. */
function regimeLabel(r) {
  if (!r) return 'unknown';
  const k = (n) => (typeof n === 'number' ? `${Math.round(n / 1000)}k` : '-');
  const h = r.handoff && typeof r.handoff.ctxThreshold === 'number' ? `hand-off ${k(r.handoff.ctxThreshold)}` : 'hand-off default';
  return `${k(r.autoCompactWindow)} compact / ${r.effort || '-'} / ${r.defaultModel || '-'} / ${h}`;
}

module.exports = { readSettings, sameSettings, settingsDraft, regimeLabel };
