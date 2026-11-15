'use strict';
// --- #467 Quiet hours: when nothing may buzz the owner's phone (docs/SUPERVISOR-DESIGN.md §6) --
//
// Quiet hours are NIGHTS plus SHABBAT and every YOM TOV, by Jerusalem times, with a margin
// on each side. A push that falls inside them is HELD, never dropped (server.js owns the
// hold and the one summary push when they end); everything here is the clock rule.
//
//   night     `nights` ("22:00-08:00") in `timeZone`, every day
//   holy day  every Saturday, and the Israeli Yom Tov days: Rosh Hashanah (1-2 Tishri),
//             Yom Kippur (10 Tishri), the first day of Sukkot (15 Tishri), Shemini Atzeret
//             (22 Tishri), the first and seventh days of Pesach (15 and 21 Nisan), Shavuot
//             (6 Sivan). A holy day on civil date D runs from candle-lighting on D-1
//             (sunset - `candleMin`) to tzeit on D (the sun `tzeitDeg` below the horizon),
//             widened by `marginMin` on each side.
//
// Windows that touch or overlap are ONE window (two holy days in a row, Shabbat beside a
// Yom Tov, the night inside Shabbat), so "when quiet hours end" is the end of the merged run.
//
// No outside service: the Hebrew date comes from Node's built-in `Intl` Hebrew calendar and
// sunset from the solar position formula (the "sunrise equation", ~1 min accurate at these
// latitudes; tests/quiet-hours.spec.js pins two years of published Jerusalem times).
//
// Pure: no I/O; every function takes `now` (epoch ms).

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const RAD = Math.PI / 180;

/** The defaults: Jerusalem, the Jerusalem candle-lighting custom (40 min), tzeit at 8.5 degrees. */
const DEFAULTS = Object.freeze({
  enabled: true,
  nights: '22:00-08:00',
  timeZone: 'Asia/Jerusalem',
  holyDays: true,
  latitude: 31.76904,
  longitude: 35.21633,
  candleMin: 40,
  tzeitDeg: 8.5,
  marginMin: 60,
});

/** The Yom Tov days kept in Israel, by Hebrew month name (as `Intl` spells it) and day. */
const YOM_TOV = Object.freeze([
  ['Tishri', 1], ['Tishri', 2], ['Tishri', 10], ['Tishri', 15], ['Tishri', 22],
  ['Nisan', 15], ['Nisan', 21], ['Sivan', 6],
]);

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _num = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? v : d);
const _hm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

/// `supervisor.quietHours` from config.json -> a full config. A bad field takes its default;
/// `false` (or `{enabled:false}`) switches quiet hours off. `nights: null` keeps only holy days.
function quietConfig(raw) {
  if (raw === false) return { ...DEFAULTS, enabled: false };
  const c = _isObj(raw) ? raw : {};
  let nights = null;
  const spec = c.nights === undefined ? DEFAULTS.nights : c.nights;
  if (typeof spec === 'string') {
    const [a, b] = spec.split('-');
    const from = _hm(a), to = _hm(b);
    nights = from !== null && to !== null && from !== to ? { from, to } : _hmPair(DEFAULTS.nights);
  }
  let timeZone = DEFAULTS.timeZone;
  if (typeof c.timeZone === 'string' && c.timeZone) {
    try { new Intl.DateTimeFormat('en', { timeZone: c.timeZone }); timeZone = c.timeZone; } catch { /* unknown zone: default */ }
  }
  return {
    enabled: c.enabled !== false,
    nights,
    timeZone,
    holyDays: c.holyDays !== false,
    latitude: _num(c.latitude, -66, 66, DEFAULTS.latitude),
    longitude: _num(c.longitude, -180, 180, DEFAULTS.longitude),
    candleMin: _num(c.candleMin, 0, 120, DEFAULTS.candleMin),
    tzeitDeg: _num(c.tzeitDeg, 0, 18, DEFAULTS.tzeitDeg),
    marginMin: _num(c.marginMin, 0, 240, DEFAULTS.marginMin),
  };
}
function _hmPair(spec) { const [a, b] = spec.split('-'); return { from: _hm(a), to: _hm(b) }; }

// --- the sun -----------------------------------------------------------------------------

/// The instant (epoch ms) the sun's centre is [depressionDeg] below the horizon in the
/// EVENING of the civil date [y]-[m]-[d] at [lat]/[lon] (east positive). 0.833 is sunset
/// (refraction plus the sun's radius). NaN where the sun never gets that low.
function sunBelow(y, m, d, lat, lon, depressionDeg) {
  const noonJd = Date.UTC(y, m - 1, d, 12) / DAY_MS + 2440587.5;
  const jStar = noonJd - 2451545.0 - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-depressionDeg * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (cosW < -1 || cosW > 1) return NaN;
  const w = Math.acos(cosW) / RAD;
  return Math.round((transit + w / 360 - 2440587.5) * DAY_MS);
}

// --- calendars ---------------------------------------------------------------------------

const _fmtCache = new Map();
function _fmt(key, make) { let f = _fmtCache.get(key); if (!f) { f = make(); _fmtCache.set(key, f); } return f; }

/// Wall-clock fields of [t] in [tz]: {y, m, d, hh, mm, wd} (wd 0 = Sunday).
function zonedParts(t, tz) {
  const f = _fmt(`z|${tz}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short' }));
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute),
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/// The instant a wall clock in [tz] reads [y]-[m]-[d] [minOfDay]. Across a DST jump the
/// nearest real instant.
function zonedTime(y, m, d, minOfDay, tz) {
  const wall = Date.UTC(y, m - 1, d, 0, minOfDay);
  const offsetAt = (t) => { const p = zonedParts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(t / MIN_MS) * MIN_MS; };
  const t1 = wall - offsetAt(wall);
  return wall - offsetAt(t1);
}

/// The Hebrew date of the DAYTIME of civil date [y]-[m]-[d]: {month, day} (month as `Intl`
/// spells it: "Tishri", "Nisan", "Adar II", ...).
function hebrewDate(y, m, d) {
  const f = _fmt('heb', () => new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', month: 'long', day: 'numeric' }));
  const p = {};
  for (const x of f.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)))) p[x.type] = x.value;
  return { month: p.month, day: Number(p.day) };
}

/// Is civil date [y]-[m]-[d] a holy day? 'shabbat', 'yomtov' or null.
function holyDayOf(y, m, d) {
  if (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() === 6) return 'shabbat';
  const h = hebrewDate(y, m, d);
  return YOM_TOV.some(([mo, da]) => mo === h.month && da === h.day) ? 'yomtov' : null;
}

const _civil = (t) => { const x = new Date(t); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };

/// The holy-day windows (margins included) that touch the civil days around [now]:
/// `[{start, end, why}]`, unmerged. Exposed for the tests.
function holyWindows(now, cfg) {
  const out = [];
  const base = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), 12);
  for (let k = -3; k <= 4; k++) {
    const day = _civil(base + k * DAY_MS);
    const why = holyDayOf(day.y, day.m, day.d);
    if (!why) continue;
    const eve = _civil(base + (k - 1) * DAY_MS);
    const candles = sunBelow(eve.y, eve.m, eve.d, cfg.latitude, cfg.longitude, 0.833) - cfg.candleMin * MIN_MS;
    const tzeit = sunBelow(day.y, day.m, day.d, cfg.latitude, cfg.longitude, cfg.tzeitDeg);
    if (!Number.isFinite(candles) || !Number.isFinite(tzeit)) continue;
    out.push({ start: candles - cfg.marginMin * MIN_MS, end: tzeit + cfg.marginMin * MIN_MS, why, candles, tzeit });
  }
  return out;
}

/// The night windows around [now], in the configured zone.
function nightWindows(now, cfg) {
  if (!cfg.nights) return [];
  const out = [];
  const { from, to } = cfg.nights;
  const p = zonedParts(now, cfg.timeZone);
  const base = Date.UTC(p.y, p.m - 1, p.d, 12);
  for (let k = -2; k <= 3; k++) {
    const a = _civil(base + k * DAY_MS);
    const b = to > from ? a : _civil(base + (k + 1) * DAY_MS);
    out.push({ start: zonedTime(a.y, a.m, a.d, from, cfg.timeZone), end: zonedTime(b.y, b.m, b.d, to, cfg.timeZone), why: 'night' });
  }
  return out;
}

/// Is [now] inside quiet hours? `{quiet, since, until, why}` - since/until are the merged
/// window's edges (epoch ms), why the kinds it is made of ("night", "shabbat", "yomtov").
/// Quiet hours off -> `{quiet: false}`.
function quietAt(now, cfgIn) {
  const cfg = cfgIn && cfgIn.timeZone ? cfgIn : quietConfig(cfgIn);
  if (!cfg.enabled) return { quiet: false, since: null, until: null, why: [] };
  const all = [...nightWindows(now, cfg), ...(cfg.holyDays ? holyWindows(now, cfg) : [])].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of all) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      if (!last.why.includes(w.why)) last.why.push(w.why);
    } else merged.push({ start: w.start, end: w.end, why: [w.why] });
  }
  const hit = merged.find((w) => w.start <= now && now < w.end);
  return hit ? { quiet: true, since: hit.start, until: hit.end, why: hit.why } : { quiet: false, since: null, until: null, why: [] };
}

module.exports = {
  DEFAULTS, YOM_TOV, quietConfig, sunBelow, zonedParts, zonedTime, hebrewDate, holyDayOf,
  holyWindows, nightWindows, quietAt,
};
