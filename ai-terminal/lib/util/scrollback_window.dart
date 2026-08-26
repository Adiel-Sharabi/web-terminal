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
/// notice it moved at all.
///
/// ## What the anchor does and does not guarantee
///
/// A cut is made only where the anchor is found AND is not part of a repeating
/// region (see [ScrollbackWindow.consume]); otherwise the walk stops. So the
/// guarantee is **conditional, not absolute**: *where the anchor is unambiguous
/// the harvest cannot repeat itself, and where it is ambiguous the walk stops
/// rather than guess* — the failure mode is less history.
///
/// It is stated that carefully because the earlier wording — *"every failure
/// mode here degrades to less history, never to history that repeats itself"* —
/// was **false as written**, and measurably so. `lastIndexOf` takes the last
/// match at or before the bound, and the bound is an UPPER bound that includes
/// the drift, so any byte-identical repeat of the anchor between the true
/// boundary and the bound wins. Measured with exact server-side bookkeeping,
/// anchor 4096, step 40000:
///
/// | fixture | wrong cuts | duplicated |
/// |---|---|---|
/// | unique content, 5 KB drift/step | 0/9 | 0 |
/// | repainted 180-unit panel, 5.4 KB drift | 3/9 | 16,650 units |
/// | run of blank lines, 5 KB drift | 1/9 | 5,000 units |
///
/// The repeat detector closes both measured shapes. The residual it does not
/// close is a frame that repeats byte for byte with a period LONGER than the
/// anchor itself — the detector only looks one anchor-length below the match it
/// chose, so a 10 KB panel redrawn identically could still fool it. Widening
/// that window is free in the healthy case (unique content has no second
/// occurrence at all) but costs a bounded scan; it is left narrow deliberately,
/// and the residual is recorded here rather than assumed away.
///
/// ## "Periodic" is a property of the ANCHOR LENGTH, not of the content
///
/// Stopping on a periodic region is right only when the boundary is genuinely
/// unknowable — and at ONE fixed anchor length it very often is not. A region
/// whose period is shorter than the anchor but which is itself SHORTER than
/// some longer anchor would be is perfectly decidable; the walk was throwing
/// away the whole rest of that session's history for it. Worse, `_exhausted`
/// is set for the LIFE of the walk, and a later `_attach` restarts from the
/// tail and meets the same region again — a permanent floor on that session's
/// history depth, with no error and no UI signal.
///
/// So before giving up, [ScrollbackWindow.consume] re-asks the SAME step with a
/// longer anchor, climbing [kScrollbackAnchorLadder] (4 KB → 16 KB → 64 KB) and
/// stopping only when the largest still self-matches. **A longer anchor can
/// only be MORE specific** — it matches nowhere the shorter one did not — so
/// escalation cannot manufacture a wrong cut; it can only turn a false stop
/// into the cut that was always correct.
///
/// Measured at production parameters (anchor 4096, step 262144, 2 MB cap, 4 KB
/// drift per gap) against a rebuilt server model, walks of 7 available steps:
///
/// | fixture | fixed anchor | with the ladder |
/// |---|---|---|
/// | prose, phrase repeats every 4096 u | 7/7 | 7/7 |
/// | repeated shell prompt (~230 u period) | 7/7 | 7/7 |
/// | `for` loop x 500 identical lines (6 KB run) | 7/7 | 7/7 |
/// | `for` loop x 2000 identical lines (25 KB run) | **3/7** | 7/7 |
/// | `for` loop x 20000 identical lines (254 KB run) | **3/7** | **3/7** |
/// | panel redrawn 30x, 733 u frame | **3/7** | 7/7 |
/// | panel redrawn 30x, 2923 u frame (88 KB region) | **3/7** | **3/7** |
/// | panel redrawn 30x, 14603 u frame | 7/7 | 7/7 |
/// | mixed agent stream, 20 randomised runs | **17/20 stopped**, avg 3.1/7 | **6/20**, avg 6.7/7 |
///
/// On the mixed stream that is 781 KB of history recovered on average, out of
/// 1792 KB available — the ladder pays for itself several times over, at a cost
/// of at most two extra round trips on the steps that need it and none at all
/// on the steps that do not.
///
/// **What it does NOT fix, and honestly cannot:** a periodic region LONGER than
/// the largest rung. A 254 KB run of one identical line, or an 88 KB block of
/// one redrawn frame, is genuinely undecidable from a 64 KB anchor — every
/// candidate boundary inside it looks exactly like every other — and stopping
/// there is the honest answer, not a gap to be closed by a bigger number. Both
/// remaining stops in the table are that shape.
///
/// ## What this module does NOT fix: the ATTACH path double-renders the tail
///
/// Recorded here so a future reader does not conclude the deepen walk is still
/// broken. `_attach` (`session_screen.dart`) clears the buffer, writes the
/// 256 KB HTTP replay, and only then opens the socket — and the server sends up
/// to `scrollbackReplayLimit` (32768) of sanitised scrollback on connect,
/// unconditionally. The client's `reconnected` handler, which clears the buffer
/// for exactly this reason, fires only on RE-connects and never on the first
/// one. Measured through the real vendored xterm at 52x38: **1129 duplicated
/// lines per attach**, at the tail, every attach — and on Windows
/// `AppLifecycleState.resumed` fires on every window focus.
///
/// That is a **different mechanism at a different layer**, pre-existing and
/// unrelated to the backward walk: it is the newest bytes arriving twice from
/// two sources, not older bytes being re-harvested. Nothing in this file can
/// see it. Fixing it means making the first connect suppress or clear the
/// socket's opening replay — the client cannot simply skip the HTTP replay, it
/// is eight times larger — which is its own change with its own risk of
/// deleting the tail instead of de-duplicating it.
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

/// The FIRST anchor length tried at each step — how much of the
/// previously-consumed slice is matched, and therefore also how far past the
/// known window that request over-fetches. A step that finds this length
/// ambiguous climbs [kScrollbackAnchorLadder] rather than giving up.
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
/// nothing whatsoever differing between them. It is 1.5% of
/// [kScrollbackDeepenBytes], so the over-fetch it costs is noise.
///
/// What IS retained is the top rung's worth — 64 KB of the head of the screen,
/// because an escalation can only match characters that were kept. One 64 KB
/// string per open session view, against the 2 MB of scrollback it is walking
/// and the terminal buffer holding the result, is still not memory worth
/// counting; the over-fetch stays at 4 KB unless a step actually needs more.
const int kScrollbackAnchorBytes = 4096;

/// The anchor lengths ONE step is allowed to try, as multiples of
/// [kScrollbackAnchorBytes] — 4 KB, 16 KB, 64 KB.
///
/// **The top rung is bounded by the server, not by taste.** `server.js` clamps
/// a `limit` above `SCROLLBACK_RANGE_MAX` (524288) silently, and the clamp
/// would cut off exactly the over-fetch the anchor lives in — escalation would
/// then fail as "anchor not found" for a reason that has nothing to do with the
/// content. The largest request this ladder can produce is
/// `kScrollbackDeepenBytes + 16 * kScrollbackAnchorBytes` = 327680, which
/// leaves room to spare; the test suite asserts it rather than trusting this
/// comment.
///
/// Three rungs, x4 apart, because each one costs a whole extra round trip
/// (`kScrollbackDeepenGap` apart) on a step that has already failed once. The
/// measurement behind the choice is in the library doc above: the ladder turns
/// 17-in-20 stopped walks into 6-in-20, and a fourth rung could not help — past
/// 64 KB the remaining stops are periodic regions hundreds of KB wide, which no
/// anchor short enough to fetch can disambiguate.
const List<int> kScrollbackAnchorLadder = <int>[1, 4, 16];

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

/// What one fetched slice turned out to be worth, and — held privately — where
/// the walk would stand if the caller uses it.
///
/// **The walk does not move until [ScrollbackWindow.commit] is called.** The
/// caller still has work to do after [ScrollbackWindow.consume] returns (render
/// the text, decide whether it produced anything to prepend), and a walk that
/// had already advanced past those bytes would turn any early return into a
/// silent HOLE in the history — the exact lie this module refuses to tell when
/// the anchor goes missing. Forgetting to commit costs a re-fetch of the same
/// range, which is harmless; committing too early costs history, which is not.
class ScrollbackHarvest {
  /// `(text, earliest, anchor, generation)` — positional because a named
  /// parameter cannot be private, and these three must not be reachable from
  /// outside the walk.
  const ScrollbackHarvest._(
    this.text,
    this._earliest,
    this._anchor,
    this._generation,
  );

  /// Nothing to add and nothing to commit. Generation `-1` is never a real
  /// walk, so [ScrollbackWindow.commit] rejects it like any stale response.
  static const ScrollbackHarvest _none = ScrollbackHarvest._('', 0, '', -1);

  /// The text genuinely older than everything already on screen — empty when
  /// this step adds nothing.
  final String text;

  final int _earliest;
  final String _anchor;
  final int _generation;
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

  /// The BASE anchor length: what a step matches on its first attempt, and the
  /// over-fetch that request adds past [earliest]. A step that finds this
  /// length ambiguous climbs [kScrollbackAnchorLadder] from here.
  final int anchorBytes;

  int _earliest = 0;
  bool _exhausted = true;
  String _anchorMaterial = '';
  int _rung = 0;
  int _generation = 0;

  /// The longest anchor the ladder can reach — and therefore how much of the
  /// head of the current screen is kept, since an escalation cannot ask for
  /// characters that were never retained.
  int get _maxAnchorBytes => anchorBytes * kScrollbackAnchorLadder.last;

  /// How long the anchor is on THIS attempt at the current step.
  int get _rungBytes => anchorBytes * kScrollbackAnchorLadder[_rung];

  /// The anchor actually matched on this attempt: the head of the screen,
  /// clipped to the current rung.
  String get _activeAnchor => _anchorMaterial.length <= _rungBytes
      ? _anchorMaterial
      : _anchorMaterial.substring(0, _rungBytes);

  /// Moves to the next rung, or reports that there is nothing longer to try.
  ///
  /// Refusing to climb when the screen's own head is already shorter than the
  /// rung asked for matters: every rung costs a whole extra round trip
  /// (`kScrollbackDeepenGap` apart), and a rung that yields a byte-identical
  /// anchor is guaranteed to reach the byte-identical verdict.
  bool _escalateAnchor() {
    if (_rung >= kScrollbackAnchorLadder.length - 1) return false;
    final before = _activeAnchor.length;
    _rung++;
    if (_activeAnchor.length > before) return true;
    _rung = kScrollbackAnchorLadder.length - 1;
    return false;
  }

  /// The offset the last fetch started at — the *request* coordinate, which is
  /// all it is good for. Where the loaded history really begins is answered by
  /// [anchor], not by this.
  int get earliest => _earliest;

  /// Whether the walk has stopped: the start of the buffer was reached, a fetch
  /// failed, or the anchor could not be found (see [consume]).
  bool get exhausted => _exhausted;

  /// The head anchor of everything currently on screen, at the length this
  /// attempt is using. Exposed for tests.
  String get anchor => _activeAnchor;

  /// The current walk. Bumped by [reset] and [noteReplay].
  int get generation => _generation;

  /// Abandons the current walk — a fresh attach replay is about to land, and
  /// any request already in flight belongs to history that no longer lines up
  /// with it.
  void reset() {
    _generation++;
    _earliest = 0;
    _exhausted = true;
    _anchorMaterial = '';
    _rung = 0;
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
    _anchorMaterial = _headMaterial(data);
    _rung = 0;
  }

  /// The next range to fetch, or null when there is nothing older to ask for.
  ///
  /// The range runs from one [stepBytes] back to the current rung's anchor
  /// length PAST the window already held. That over-fetch is the whole trick:
  /// with no drift the anchor begins exactly at [earliest], so without it the
  /// anchor would sit one byte past the end of the slice and could never be
  /// matched. After an escalation the same step is asked for again, reaching
  /// further forward so the LONGER anchor is inside the slice too.
  ScrollbackRequest? nextRequest() {
    if (_exhausted) return null;
    if (_earliest <= 0) {
      _exhausted = true;
      return null;
    }
    final start = scrollbackTailOffset(_earliest, stepBytes);
    final end = _earliest + _rungBytes;
    return ScrollbackRequest(
      offset: start,
      limit: end - start,
      generation: _generation,
    );
  }

  /// Folds a fetched slice into the walk, returning the text that is genuinely
  /// older than everything already on screen. **The walk itself does not move
  /// until [commit] is handed the result** — see [ScrollbackHarvest].
  ///
  /// [generation] must be the one carried by the [ScrollbackRequest] this
  /// response answers. A mismatch means an attach re-armed the walk while the
  /// request was in flight; the response is dropped without touching any state,
  /// because writing `earliest` from it is exactly the corruption that leaves a
  /// hole in history and restarts the walk from the wrong place.
  ///
  /// **When the boundary cannot be established the walk STOPS**, for all four
  /// reasons it can fail: the slice is empty, **at any offset** — a shrinking
  /// buffer answers a request that fell off its front with nothing, and a walk
  /// that stayed armed there re-issued the identical request every 900 ms for
  /// ever; there is no anchor to cut on; the anchor is nowhere in the slice (the
  /// buffer moved further than a whole step, 256 KB inside one 900 ms gap); or
  /// the anchor repeats **at every length the ladder can reach** — a repeat at
  /// the current length only re-asks the same step with a longer anchor (see
  /// [kScrollbackAnchorLadder]), and gives up only at the top rung. In each
  /// terminal case the
  /// position of the boundary is unknown, and both ways of guessing are worse
  /// than stopping: keeping the slice duplicates whatever part of it is already
  /// on screen (the reported bug), and skipping it while still advancing leaves
  /// a silent HOLE in the history, which is the same class of lie. History
  /// simply stays as deep as it already is, which is what a failed fetch does
  /// too.
  ScrollbackHarvest consume({
    required String data,
    required int offset,
    required int generation,
  }) {
    if (generation != _generation) return ScrollbackHarvest._none;
    if (offset <= 0) _exhausted = true;
    // An empty slice stops the walk AT ANY OFFSET, and the `offset <= 0` line
    // above is not enough on its own. `start = min(offset, total)` means the
    // server answers a request that has fallen off the front of a SHRINKING
    // buffer with nothing, at a positive offset — and nothing about the walk
    // changes: `earliest` does not move, so `nextRequest` returns the identical
    // range, `commit` of an empty harvest is a no-op, and `_deepenOnce`'s
    // `finally` re-arms the timer. That is the same request every 900 ms for
    // the life of the view, for ever.
    if (data.isEmpty) {
      _exhausted = true;
      return ScrollbackHarvest._none;
    }

    final previous = _activeAnchor;
    // No anchor means nothing to cut on. The old reading here was "nothing is on
    // screen yet (an attach that replayed no bytes), so there is nothing this
    // slice could duplicate" — which is unsound: an attach whose HTTP replay
    // came back empty still ends up with a terminal filled by the SOCKET replay,
    // and prepending the whole slice uncut lands it on top of text it overlaps.
    if (previous.isEmpty) {
      _exhausted = true;
      return ScrollbackHarvest._none;
    }

    // Where the boundary would sit if nothing had drifted: the anchor's content
    // was at absolute `_earliest`, and this slice starts at `offset`.
    //
    // It is an upper bound, not a guess, and that is the point of searching only
    // up to it. Head-trimming strips strictly MORE from the front on every
    // request, so drift overwhelmingly pulls the anchor EARLIER into the slice,
    // and a match past this point is a self-repeat inside text already on
    // screen; a repainting TUI supplies those by the screenful, and cutting
    // there is exactly the duplication this exists to stop.
    //
    // "No byte EVER moves to a higher offset" would be the clean statement of
    // that, and it is not strictly provable: the server sanitises the buffer
    // before slicing it, and a trim boundary that splits a DA/DSR sequence
    // retains bytes the previous sanitise had stripped, which nudges every tail
    // offset UP by that much. It holds in practice because the trimmed head's
    // sanitised contribution dwarfs those few bytes — and when it does not, the
    // anchor falls outside the bound, is not found, and the walk stops. The
    // residual failure is the declared fallback, not a corruption.
    var limit = _earliest - offset;
    if (limit < 0) {
      _exhausted = true;
      return ScrollbackHarvest._none;
    }
    // The bound is a WALK coordinate; the slice may be shorter than the walk
    // expects (`persistScrollback` is off by default, so a worker restart
    // collapses a session's scrollback to nothing and it regrows from there).
    // `String.lastIndexOf` throws when its start is past the end, and
    // `_deepenOnce`'s catch-all would swallow that into a walk that silently
    // dies for the rest of the session.
    if (limit > data.length) limit = data.length;

    // Within the bound, the LAST occurrence. An earlier match is content that
    // the later one proves is genuinely older, and cutting there throws it away
    // for good.
    final cut = data.lastIndexOf(previous, limit);
    if (cut < 0) {
      _exhausted = true;
      return ScrollbackHarvest._none;
    }

    // ...unless the anchor REPEATS, in which case "the last occurrence" is not
    // evidence of anything. A TUI that redraws the same frame, or an idle agent
    // printing blank lines, fills the buffer with a region that matches at every
    // period, and the bound's own drift slack is what lets a later one win. Scan
    // forward from one anchor-length below the match: a hit before it proves the
    // region is periodic and the cut cannot be trusted. Forward, not backward,
    // so the scan is bounded by the anchor length instead of the whole slice.
    final from = cut > previous.length ? cut - previous.length : 0;
    if (from < cut && data.indexOf(previous, from) < cut) {
      // Periodic AT THIS ANCHOR LENGTH — which is a much weaker statement than
      // "unknowable", and treating the two as the same was measurably wrong.
      // Retry the SAME step with a longer anchor first: a period shorter than
      // the anchor is what makes the region ambiguous, so an anchor that
      // outreaches the region ends in text that occurs nowhere else and the
      // boundary becomes decidable again. Only when the longest rung still
      // self-matches is the region genuinely undecidable, and stopping honest.
      if (!_escalateAnchor()) _exhausted = true;
      return ScrollbackHarvest._none;
    }

    return ScrollbackHarvest._(
      data.substring(0, cut),
      offset,
      _headMaterial(data),
      generation,
    );
  }

  /// Moves the walk onto [harvest] — call it once the harvest has been
  /// accounted for, whether or not it produced anything to show.
  ///
  /// A harvest from an abandoned walk is ignored, for the same reason [consume]
  /// drops one: it describes history that is no longer on screen.
  void commit(ScrollbackHarvest harvest) {
    if (harvest._generation != _generation) return;
    _earliest = harvest._earliest;
    _anchorMaterial = harvest._anchor;
    // Back to the cheap rung. Escalation is a property of the STEP that needed
    // it, not of the walk: the periodic region is now behind the boundary, and
    // carrying its rung forward would buy nothing while over-fetching 64 KB on
    // every remaining step.
    _rung = 0;
    if (_earliest <= 0) _exhausted = true;
  }

  /// The head of the screen, kept at the longest length any rung could ask for
  /// — an escalation can only match characters that were retained here.
  String _headMaterial(String data) => data.length <= _maxAnchorBytes
      ? data
      : data.substring(0, _maxAnchorBytes);
}

/// How many of a scratch terminal's [bufferLines] are worth prepending: all of
/// them, minus the trailing BLANK ones ([isBlank] answers for one line).
///
/// The scratch terminal's own viewport contributes those blanks, and they would
/// show up as a gap between the older text and what is already on screen.
///
/// ## Why this does not drop the viewport, which it briefly did
///
/// A terminal's buffer is scrollback followed by its viewport, and at a seam
/// that viewport is the screen as of the byte the slice stops at. When the
/// continuation REPAINTS — an agent's `/context` panel, a spinner — that frame
/// is drawn again below, so keeping it stamps a stale copy into the scrollback.
/// Dropping the trailing `viewHeight` lines makes such a seam render exactly as
/// one contiguous replay would.
///
/// **It is the wrong trade by an order of magnitude, because it is silent.**
/// For output the continuation does *not* repaint — plain scrolling text — the
/// last screenful is REAL HISTORY, and dropping it deletes it with no error
/// anywhere. Measured against the real vendored xterm (52x38, 300 plain lines,
/// seam at 200, no escape sequences):
///
/// * viewport-drop kept 163 lines and **LOST 37** (`T000163..T000199`)
/// * blank-trim kept 200 and lost **0**
///
/// That is `rows - 1` real lines per seam; at ~8 seams on a phone, **~296 lines
/// silently deleted** by the feature whose entire job is to deepen history. What
/// it buys back is ~43 duplicated lines across a whole walk (4446 harvested
/// against 4403 for a contiguous replay). ~43 duplicated against ~296 deleted is
/// not a trade worth making, and a hole in the middle of the scrollback is
/// precisely what [ScrollbackWindow.consume]'s own reasoning rejects when it
/// refuses to skip-but-advance.
///
/// So the residual is accepted and pinned instead: a repainting seam CAN stamp
/// one extra frame, bounded by one screen, and the seam tests record it. Do not
/// "re-optimise" this back.
int olderLineLimit(int bufferLines, bool Function(int index) isBlank) {
  var keep = bufferLines;
  while (keep > 0 && isBlank(keep - 1)) {
    keep--;
  }
  return keep;
}
