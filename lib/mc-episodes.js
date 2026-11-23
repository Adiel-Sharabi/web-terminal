'use strict';
// #506 - Mission Control: when a prompt on a session's screen (a question, a permission
// prompt) came up, so its Answer-now card keeps ONE id for as long as it is up.
//
// A reported wait carries its own time (`wait.at`); a prompt on screen carries none. The
// session's last activity is no name for it: every PTY chunk and every hook moves it (a
// viewer's resize redraw, Claude's idle Notification a minute in), so a card parked on My
// to-do would come straight back. This records an EPISODE per session instead: it opens the
// first time a Mission Control view sees the session at a prompt (at its last activity then:
// a session at a prompt prints nothing, so that is when the prompt was drawn) and holds while
// every later view sees it at the same kind of prompt in the same turn. It closes the first
// time a view sees the session anywhere else, and the next prompt opens a new one, so a
// second permission prompt is a new card. Known limit: two prompts in one turn with no view
// computed between them (nobody looking) read as one episode.
//
// In memory, on the authority: a restart opens new episodes (a parked card comes back once:
// wrong toward showing). Pure apart from its own map; the clock is passed in.

const promptKind = (n) => (n && (n.waitingFor === 'question' || n.waitingFor === 'permission') ? n.waitingFor : null);

function createPromptEpisodes() {
  const open = new Map(); // `<server>|<session>` -> {kind, turnAt, since}
  const last = new Map(); // `<server>|<session>` -> the since of its latest episode

  /** Read one view's session nodes (lib/mc-subjects.js sessionNodes): set `promptSince` on
   *  every live node at a prompt, and close the episode of every node that is not. */
  function observe(nodes, now) {
    const seen = new Set();
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || n.closed) continue;
      const kind = promptKind(n);
      if (!kind) continue;
      const k = `${n.server || ''}|${n.id}`;
      seen.add(k);
      const turnAt = Number.isFinite(n.turnAt) ? n.turnAt : null;
      const e = open.get(k);
      if (e && e.kind === kind && e.turnAt === turnAt) { n.promptSince = e.since; continue; }
      let since = Number.isFinite(n.lastActivity) && n.lastActivity <= now ? n.lastActivity : now;
      // A new episode never takes the name of an earlier one.
      const prev = last.get(k);
      if (Number.isFinite(prev) && since <= prev) since = prev + 1;
      open.set(k, { kind, turnAt, since });
      last.set(k, since);
      n.promptSince = since;
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
    // A session gone from every view forgets its last name too (bounded by live sessions).
    if (last.size > 4 * Math.max(open.size, 250)) for (const k of [...last.keys()]) if (!open.has(k)) last.delete(k);
  }
  return { observe };
}

module.exports = { createPromptEpisodes };
