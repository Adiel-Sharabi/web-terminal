'use strict';
// The session terminal socket, for the rig verifiers.
//
// THE handshake detail that makes or breaks a verifier: a session WebSocket opens as a
// BACKGROUND viewer (`ws._wtBackground = true`, server.js), and a background viewer's
// keystrokes are DROPPED — `if (ws._wtBackground) return;` — until the client declares
// itself with `{"mode":"active"}`. Output still streams the whole time.
//
// So a probe that connects, waits for the composer, and types gets exactly what a real
// client would... except that nothing it types ever reaches the PTY. It looks alive, it
// reads the screen, and it silently proves NOTHING. Both rig verifiers had this bug — hence
// this module: the handshake lives in ONE place and every probe goes through it.

const WebSocket = require('ws');
const { WS_BASE } = require('./rig-http');

/**
 * Open a session's terminal socket as an ACTIVE viewer (one whose input is honoured).
 *
 * Resolves once the socket is open and the mode declared. `text()` returns everything the
 * PTY has emitted so far; `send()` writes bytes to it exactly as a client keypress would.
 */
async function openTerminal(cookie, id) {
  const ws = new WebSocket(`${WS_BASE}/ws/${id}`, { headers: { Cookie: cookie } });
  let out = '';
  ws.on('message', (d) => { out += d.toString('utf8'); });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // Without this, every send() below is silently discarded by the server.
  ws.send(JSON.stringify({ mode: 'active', browserId: 'rig-probe' }));

  return {
    ws,
    text: () => out,
    send: (s) => ws.send(s),
    close: () => { try { ws.close(); } catch {} },
  };
}

module.exports = { openTerminal };
