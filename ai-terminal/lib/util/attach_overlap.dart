/// The cut that stops an attach rendering its newest bytes twice (#176).
///
/// ## The two replays
///
/// `_attach` writes a 256 KB replay fetched over HTTP, and *then* opens the
/// socket — and the server replays up to `scrollbackReplayLimit` (32 KB) on
/// connect, unconditionally. Both land in the same terminal, so the newest
/// ~32 KB is rendered twice. Measured through the real vendored xterm at 52x38:
/// **1129 duplicated lines per attach**, at the tail — and on Windows
/// `AppLifecycleState.resumed` fires on every window focus, so that is every
/// time the window is clicked.
///
/// ## Why the obvious fixes are wrong, and what was measured instead
///
/// Suppressing the socket's opening replay loses the bytes emitted between the
/// HTTP fetch and the socket connect — a silent HOLE, which this codebase treats
/// as strictly worse than a visible duplicate. Deriving the replay's byte range
/// from `total` needs the two sanitiser passes to agree, and `_attach`'s own doc
/// refused to assume that without evidence.
///
/// So it was measured, against a live server (2026-08-27), comparing the socket's
/// opening replay with `GET /api/sessions/:id/scrollback` over the same buffer:
///
/// | content | stripped replay is an exact substring | common SUFFIX run |
/// |---|---|---|
/// | plain text | **yes**, at exactly `httpLen - replayLen` | 32768 / 32768 |
/// | escape-heavy (DA/DSR/ED + alt-screen) | **no** | **30947 / 31517** |
///
/// The escape-heavy divergence is real and its mechanism is exactly the one that
/// was feared. At the first difference:
///
/// ```text
/// socket: "PMARK-5080-yyyyyyyyyyyyyyyyyyyy\r\nPMARK-5"        <- ESC[2J stripped
/// http  : "K-5080-yyyyyyyyyyyyyyyyyyyyESC[2J\r\nPMARK-5"   <- ESC[2J kept
/// ```
///
/// `sanitizeReplay` strips an ED erase only when it believes it is OUTSIDE
/// alt-screen, and it tracks that from the start of whatever string it is given.
/// The socket's copy is TRUNCATED first, so it begins mid-stream, never sees the
/// earlier `ESC[?1049h`, and strips an erase the whole-buffer pass keeps.
///
/// **The consequence that matters: they diverge near the socket replay's HEAD and
/// agree over its TAIL.** That is what makes this fixable — and it is why the
/// anchor here is taken from the END of what is on screen, never from the head of
/// the incoming replay.
///
/// ## The rule
///
/// The end of what is on screen is the end of the HTTP replay. That same text sits
/// somewhere inside the socket replay — near its end when the session was idle
/// between the two, earlier when it was busy. Find it, and everything after it is
/// the only genuinely new content.
///
/// **The FIRST match wins, not the last** — the opposite of the backward walk in
/// `scrollback_window.dart`, and for a reason worth stating because the two rules
/// sit next to each other. Here a match that is too LATE cuts away live output
/// that was never rendered: a hole. A match that is too EARLY re-renders a little
/// of what is already on screen: a duplicate. Given a repeating region and no way
/// to tell which occurrence is the true boundary, this errs toward the duplicate,
/// because a hole is the one failure the user cannot see.
///
/// **When the anchor is not found at all, everything is written** — which is
/// exactly today's behaviour. That case is legitimate (more than a whole replay's
/// worth of output between the fetch and the connect leaves no overlap to cut) and
/// it is also the honest fallback for a divergence this rule cannot see through.
/// So the worst this can do is what already happens; it cannot introduce a hole.
library;

/// How much of the rendered tail is matched. 4 KB for the same reason
/// `kScrollbackAnchorBytes` is 4 KB: agent-TUI scrollback is made of near-identical
/// repaints, so a few hundred bytes can genuinely occur twice, while 4 KB spans
/// ~35 lines *including* their escape sequences.
///
/// It is also comfortably inside the measured region of agreement — the two
/// sanitiser passes matched over the last 30947 units of a 31517-unit replay, so a
/// 4 KB anchor taken from the end sits nowhere near the divergence at the head.
const int kAttachAnchorBytes = 4096;

/// The portion of [incoming] that is NOT already on screen.
///
/// [rendered] is what the terminal currently holds (or its tail — only the last
/// [anchorBytes] are ever used). [incoming] is the socket's opening replay.
///
/// Returns [incoming] unchanged when there is nothing to anchor on or the anchor
/// cannot be found, which is the pre-#176 behaviour and never a hole.
String cutAttachOverlap(
  String rendered,
  String incoming, {
  int anchorBytes = kAttachAnchorBytes,
}) {
  if (incoming.isEmpty || rendered.isEmpty) return incoming;

  // The bracketed-paste mode the worker prepends to an attach replay
  // (`pty-worker.js`: `if (session.bracketedPaste) full = '\x1b[?2004h' + full`)
  // is REAL terminal state, not content — it is not in the scrollback and so can
  // never match the anchor. Keep it and cut only what follows, or re-attaching to
  // a session in bracketed-paste mode would silently drop the mode change.
  // Measured: the replay was 32776 = 32768 + these 8 units.
  const bp = '\x1b[?2004h';
  final prefix = incoming.startsWith(bp) ? bp : '';
  final body = incoming.substring(prefix.length);
  if (body.isEmpty) return incoming;

  final anchor = rendered.length <= anchorBytes
      ? rendered
      : rendered.substring(rendered.length - anchorBytes);

  // FIRST occurrence — see the library doc: too late cuts live output (a hole),
  // too early re-renders a little (a duplicate), and only one of those is
  // invisible to the user.
  final at = body.indexOf(anchor);
  if (at < 0) return incoming; // no overlap to cut, or a divergence: write it all

  final cut = at + anchor.length;
  if (cut >= body.length) return prefix; // the replay was entirely on screen already
  return prefix + body.substring(cut);
}
