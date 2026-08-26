/// The backward walk through a session's scrollback (#127), and the content
/// anchoring that keeps it honest when the server's buffer slides underneath it
/// (#167).
///
/// ## Why an absolute byte offset is not a position
///
/// `GET /api/sessions/:id/scrollback` slices a buffer whose **head the worker
/// trims on every PTY write** (`pty-worker.js` `trimScrollback`, 2 MB cap). The
/// slice a single response returns is exact — but offset 0 means a *different
/// byte* on every request, and nothing in the response says so: `total` sits
/// pinned at the cap.
///
/// So a walk that remembers "I have everything from byte X onwards" and next
/// asks for `[X - step, X)` re-harvests the last D bytes it already showed,
/// where D is whatever the session emitted in between. Measured with the real
/// arithmetic: **the duplicated bytes per step equal the bytes emitted since the
/// previous step, exactly** — which is why the reported symptom was output
/// blocks repeating and *"scrolling made it worse"*. At the step size itself,
/// every step is 100% duplicate.
///
/// ## The rule: anchor on content, cut where the content repeats
///
/// After each fetch this keeps a **head anchor** — the first
/// [kScrollbackAnchorBytes] code units of the slice just consumed, i.e. the
/// exact text that now begins everything on screen. The next request
/// deliberately **over-fetches** by the anchor's length so the anchor is inside
/// the returned slice even when nothing drifted, and the slice is cut where the
/// anchor reappears. Everything from there on is already on screen and is
/// dropped.
///
/// The boundary is then found wherever the trimming put it, however far the
/// buffer moved — which an offset cannot do, because an offset has no way to
/// notice it moved at all. When the anchor cannot be found the walk stops
/// rather than guess, so every failure mode here degrades to *less history*,
/// never to history that repeats itself.
///
/// Nothing here touches a terminal, a widget or the network — it is the rule
/// only, so the whole walk is testable without pumping a screen or a server.
library;

/// Where the newest [budget] code units of a [total]-length scrollback begin.
///
/// The endpoint pages FORWARD from `offset`, so fetching the tail means asking
/// for `total - budget`. Omitting the offset asks for the oldest bytes instead,
/// which is the whole defect this exists to prevent. Pure, so the arithmetic is
/// pinned without a live session.
int scrollbackTailOffset(int total, int budget) {
  final start = total - budget;
  return start > 0 ? start : 0;
}

/// How much older scrollback each background deepening step pulls in (#127).
/// One step, one request, one prepend — small enough that parsing it never
/// blocks the frame for long, large enough that a deep history arrives quickly.
const int kScrollbackDeepenBytes = 262144;

/// How much of the previously-consumed slice is kept as the content anchor, and
/// therefore also how far past the known window each request over-fetches.
///
/// **4 KB, chosen against both failure modes.** Too short and the anchor
/// false-matches: agent-TUI scrollback is *made* of near-identical repaints, so
/// a few hundred bytes can genuinely occur twice and the cut lands in the wrong
/// place. Too long and it costs over-fetch on every step for no extra
/// certainty, and grows the chance that a slice near the very start of the
/// buffer is shorter than the anchor itself.
///
/// At the measured ~110 code units per line of agent-TUI scrollback, 4 KB spans
/// roughly 35 lines *including* their escape sequences — cursor addresses,
/// colour changes and the numbers a repaint carries. For that to repeat byte
/// for byte the terminal would have to print two consecutive frames with
/// nothing whatsoever differing between them. It is 1.5% of [kScrollbackDeepenBytes],
/// so the over-fetch it costs is noise, and one 4 KB string per screen is not
/// memory worth counting.
const int kScrollbackAnchorBytes = 4096;

/// One backward step: the byte range to ask the server for, stamped with the
/// walk [generation] it belongs to.
class ScrollbackRequest {
  /// Creates a request value object.
  const ScrollbackRequest({
    required this.offset,
    required this.limit,
    required this.generation,
  });

  /// First code unit to fetch.
  final int offset;

  /// How many code units to fetch. Includes the deliberate anchor over-fetch.
  final int limit;

  /// The walk this request was issued for — hand it back to
  /// [ScrollbackWindow.consume] so a response that outlived its walk is
  /// discarded instead of corrupting the new one.
  final int generation;

  @override
  String toString() =>
      'ScrollbackRequest(offset=$offset, limit=$limit, gen=$generation)';
}

/// Tracks how far back through a session's scrollback the client has read, and
/// turns each fetched slice into the text that is genuinely OLDER than
/// everything already on screen.
class ScrollbackWindow {
  /// Creates a walk. The defaults are the shipped ones; the parameters exist so
  /// a test can drive the same rules over a small buffer.
  ScrollbackWindow({
    this.stepBytes = kScrollbackDeepenBytes,
    this.anchorBytes = kScrollbackAnchorBytes,
  });

  /// How far back each step reaches.
  final int stepBytes;

  /// Anchor length, and the over-fetch each request adds past [earliest].
  final int anchorBytes;

  int _earliest = 0;
  bool _exhausted = true;
  String _anchor = '';
  int _generation = 0;

  /// The offset the last fetch started at — the *request* coordinate, which is
  /// all it is good for. Where the loaded history really begins is answered by
  /// [anchor], not by this.
  int get earliest => _earliest;

  /// Whether the walk has stopped: the start of the buffer was reached, a fetch
  /// failed, or the anchor could not be found (see [consume]).
  bool get exhausted => _exhausted;

  /// The head anchor of everything currently on screen. Exposed for tests.
  String get anchor => _anchor;

  /// The current walk. Bumped by [reset] and [noteReplay].
  int get generation => _generation;

  /// Abandons the current walk — a fresh attach replay is about to land, and
  /// any request already in flight belongs to history that no longer lines up
  /// with it.
  void reset() {
    _generation++;
    _earliest = 0;
    _exhausted = true;
    _anchor = '';
  }

  /// Stops the walk where it is, keeping the history already loaded.
  void stop() {
    _exhausted = true;
  }

  /// Records the attach replay — [data] is the newest slice, already written to
  /// the live terminal, and [offset] is where the server said it begins.
  ///
  /// This starts a new walk: anything in flight from the previous one is
  /// rejected by [consume] from here on.
  void noteReplay({required String data, required int offset}) {
    _generation++;
    _earliest = offset;
    _exhausted = offset <= 0;
    _anchor = _headAnchor(data);
  }

  /// The next range to fetch, or null when there is nothing older to ask for.
  ///
  /// The range runs from one [stepBytes] back to [anchorBytes] PAST the window
  /// already held. That over-fetch is the whole trick: with no drift the anchor
  /// begins exactly at [earliest], so without it the anchor would sit one byte
  /// past the end of the slice and could never be matched.
  ScrollbackRequest? nextRequest() {
    if (_exhausted) return null;
    if (_earliest <= 0) {
      _exhausted = true;
      return null;
    }
    final start = scrollbackTailOffset(_earliest, stepBytes);
    final end = _earliest + anchorBytes;
    return ScrollbackRequest(
      offset: start,
      limit: end - start,
      generation: _generation,
    );
  }

  /// Folds a fetched slice into the walk and returns the text that is genuinely
  /// older than everything already on screen — empty when this step adds
  /// nothing.
  ///
  /// [generation] must be the one carried by the [ScrollbackRequest] this
  /// response answers. A mismatch means an attach re-armed the walk while the
  /// request was in flight; the response is dropped without touching any state,
  /// because writing `earliest` from it is exactly the corruption that leaves a
  /// hole in history and restarts the walk from the wrong place.
  ///
  /// **When the anchor is not found the walk STOPS.** That needs the buffer to
  /// have moved further than a whole step (256 KB inside one 900 ms gap), so it
  /// is rare — but the position of the boundary is then unknown, and both ways
  /// of guessing are worse than stopping: keeping the slice duplicates whatever
  /// part of it is already on screen (the reported bug), and skipping it while
  /// still advancing leaves a silent HOLE in the history, which is the same
  /// class of lie. History simply stays as deep as it already is, which is what
  /// a failed fetch does too.
  String consume({
    required String data,
    required int offset,
    required int generation,
  }) {
    if (generation != _generation) return '';
    final wasEarliest = _earliest;
    _earliest = offset;
    if (offset <= 0) _exhausted = true;
    if (data.isEmpty) return '';

    final previous = _anchor;
    _anchor = _headAnchor(data);
    // Nothing is on screen yet (an attach that replayed no bytes), so there is
    // nothing this slice could duplicate.
    if (previous.isEmpty) return data;

    // Where the boundary would sit if nothing had drifted: the anchor's content
    // was at absolute `wasEarliest`, and this slice starts at `offset`.
    //
    // It is an upper bound, not a guess, and that is the point of searching only
    // up to it. The server's head is TRIMMED, never grown — no byte ever moves
    // to a HIGHER offset — so drift can only pull the anchor EARLIER into the
    // slice. Any match past this point is therefore a self-repeat inside text
    // already on screen, and a repainting TUI supplies those by the screenful;
    // cutting there is exactly the duplication this exists to stop.
    final limit = wasEarliest - offset;
    if (limit < 0) {
      _exhausted = true;
      return '';
    }

    // Within the bound, the LAST occurrence. An earlier match is content that
    // the later one proves is genuinely older, and cutting there throws it away
    // for good.
    final cut = data.lastIndexOf(previous, limit);
    if (cut < 0) {
      _exhausted = true;
      return '';
    }
    return data.substring(0, cut);
  }

  String _headAnchor(String data) =>
      data.length <= anchorBytes ? data : data.substring(0, anchorBytes);
}

/// How many of a scratch terminal's [bufferLines] are older scrollback rather
/// than its own viewport (#167).
///
/// A terminal's buffer is scrollback followed by exactly [viewHeight] viewport
/// lines, and the viewport is **a frame, not history**: it is the screen as of
/// the byte the slice stops at, and the text that follows in the live buffer is
/// the continuation repainting over it. Harvesting it stamps a stale copy of
/// that frame into the scrollback at every seam.
///
/// The old rule trimmed only *blank* trailing lines, which a TUI frame is not —
/// so a `/context` panel, a spinner or any full-screen render was kept whole and
/// then immediately repainted by the live text below it. Measured on a
/// full-screen repaint at the seam: 339 harvested lines against 302 for one
/// contiguous replay of the same bytes, diverging at line 163; dropping the
/// viewport makes the two **identical**.
///
/// What it costs, stated rather than hidden: for output the continuation does
/// *not* repaint — plain scrolling text — the last screenful of the slice is
/// real history and is lost, up to [viewHeight] lines per seam. That is the
/// right trade both ways round. A repainted line's honest value is the
/// continuation's newer render, which is what a contiguous replay would show;
/// and a bounded amount of missing history beats history that lies.
int olderLineLimit(int bufferLines, int viewHeight) {
  final older = bufferLines - viewHeight;
  return older > 0 ? older : 0;
}
