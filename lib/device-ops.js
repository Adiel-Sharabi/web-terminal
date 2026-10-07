'use strict';
// --- Which device sent each prompt? (#311) -----------------------------------
//
// One line per submit, so a week of use answers "how much of my work is done from
// the phone, the tablet or a desktop, and at home or at the office".
//
// THE DEVICE IS NAMED BY ITS TAILNET ADDRESS, NOT GUESSED. `tailscale serve` relays
// every caller onto a loopback socket and adds `x-forwarded-for: <client tailnet IP>`
// (measured in #297, see lib/local-request.js). A tailnet IP is one device, so the
// phone, the tablet and each desktop are told apart exactly - no User-Agent sniffing
// and no screen-size threshold that a tablet or an unfolded phone would straddle.
// `x-forwarded-for` is trusted only from a loopback socket, the same rule #300 asks
// of the rate limiter: from anywhere else the header is the caller's own claim.
//
// WHAT IS RECORDED: time, source, and the name of the server that took the input.
// NEVER the input. The source is resolved to a device name and class only by the
// report (scripts/device-ops-report.js), from `tailscale status`, so nothing
// machine-specific lives in this repo.
//
// One submit is recorded once: the companion connects straight to the server that
// owns the session, and only that server's `/ws/:id` handler records. A frame relayed
// by the cluster proxy (`/cluster/:serverUrl/ws/:id`, used only by app.html) arrives
// from the relaying peer and is recorded with that peer as its source.

const fs = require('fs');
const path = require('path');
const { LOOPBACK, isRelayed } = require('./local-request');

const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/// The client behind a request: its tailnet IP, `local` for a direct loopback
/// caller (a client on the server's own machine), or `unknown`.
function clientSource(req) {
  const ip = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  const headers = req?.headers || {};
  if (LOOPBACK.has(ip)) {
    if (!isRelayed(headers)) return 'local';
    const first = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
    return IP_RE.test(first) ? first : 'unknown';
  }
  const bare = ip.replace(/^::ffff:/, '');
  return IP_RE.test(bare) ? bare : 'unknown';
}

/// A submit is an input frame ending in CR - the shape `buildComposeSubmission`
/// sends and the Enter key types (#55). Control frames are JSON and never end in CR.
function isSubmitFrame(msg) {
  if (Buffer.isBuffer(msg)) return msg.length > 0 && msg[msg.length - 1] === 0x0d;
  return typeof msg === 'string' && msg.length > 0 && msg.charCodeAt(msg.length - 1) === 0x0d;
}

let _dirReady = null;
let _errorLogged = false;

/// Append one record. Fire-and-forget: a stats line must never delay or refuse input.
function recordOp(file, rec) {
  try {
    if (_dirReady !== file) { fs.mkdirSync(path.dirname(file), { recursive: true }); _dirReady = file; }
  } catch {}
  fs.appendFile(file, JSON.stringify(rec) + '\n', (err) => {
    if (err && !_errorLogged) {
      _errorLogged = true;
      console.error(`[${new Date().toISOString()}] device-ops: cannot append (${err.code || err.message}); further failures not logged`);
    }
  });
}

const MOBILE_OS = /^(android|ios|ipados)$/i;

/// mobile / tablet / desktop. A tablet runs a mobile OS, so it is named in config
/// (`deviceClasses: { "<host>": "tablet" }`); everything else follows from the OS.
function classOf(device, classes) {
  const override = classes && classes[device.host];
  if (override) return String(override);
  return MOBILE_OS.test(String(device.os || '')) ? 'mobile' : 'desktop';
}

const BLOCK_GAP_MS = 30 * 60e3;   // prompts closer than this are one working block
const BLOCK_TAIL_MS = 10 * 60e3;  // ...and each block is credited this much after its last prompt

/// Office hours: Sunday-Thursday 09:00-18:00, local time of the machine running the report.
function inOfficeHours(d) {
  const day = d.getDay(), h = d.getHours();
  return day <= 4 && h >= 9 && h < 18;
}

/// Per-device totals, most operations first. `resolve(src)` names the device behind a
/// source; a `local` source is the machine of the server that recorded it, named by
/// `serverHost(serverName)` so it lands on the same row as that machine's relayed input.
function summarize(records, { resolve, serverHost = () => null, classes = {}, officeHours = inOfficeHours } = {}) {
  const by = new Map();
  for (const r of records) {
    const t = Date.parse(r.t);
    if (Number.isNaN(t)) continue;
    const dev = r.src === 'local'
      ? { host: serverHost(r.server) || r.server, os: 'server' }
      : (resolve(r.src) || { host: r.src, os: '' });
    let row = by.get(dev.host);
    if (!row) { row = { device: dev.host, cls: classOf(dev, classes), ops: 0, office: 0, outside: 0, times: [] }; by.set(dev.host, row); }
    row.ops++;
    if (officeHours(new Date(t))) row.office++; else row.outside++;
    row.times.push(t);
  }
  const rows = [...by.values()].map(({ times, ...row }) => {
    times.sort((a, b) => a - b);
    let ms = 0, start = null, last = null;
    for (const t of times) {
      if (last !== null && t - last > BLOCK_GAP_MS) { ms += last - start + BLOCK_TAIL_MS; start = t; }
      if (start === null) start = t;
      last = t;
    }
    if (start !== null) ms += last - start + BLOCK_TAIL_MS;
    return { ...row, hours: ms / 36e5 };
  });
  return rows.sort((a, b) => b.ops - a.ops);
}

module.exports = { clientSource, isSubmitFrame, recordOp, classOf, summarize, inOfficeHours };
