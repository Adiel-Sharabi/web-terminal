/// The chat lens's peek at the terminal (#194 Part 1): the last few non-blank
/// rows of whatever the terminal is CURRENTLY SHOWING, so a session blocked on
/// something the chat lens has no bubble for is still visible from chat.
///
/// ## Why this does not classify
///
/// #179 measured, off a real PTY, that `/usage`, an open slash menu and Agent
/// View each swallow a submitted prompt as navigation and NOT ONE of them
/// emits a distinguishing byte or fires a hook. A classifier built to
/// recognise "blocked" states is therefore permanently incomplete — every
/// unmeasured shape (a future Claude release, a different agent, a plain
/// shell sitting in `less`) falls straight through it, silently. Showing the
/// screen itself has no such gap: whatever the terminal is doing, this rule
/// reports it verbatim, so there is nothing left to fail to recognise.
///
/// ## Why this reads the BUFFER, never raw scrollback bytes
///
/// Claude's folder-trust dialog (#190) positions every word with CHA
/// (`ESC[<col>G`) and writes NO literal spaces at all — the raw bytes read
/// `Quicksafetycheck:Isthis…`, and turning that back into the words a human
/// reads means re-implementing column tracking over an escape stream. The
/// xterm buffer has already done exactly that: each cell holds whatever
/// character is actually showing at its column, so [rowText] answering with
/// `BufferLine.getText()` gets the spacing back for free. `GET
/// /api/sessions/:id/scrollback` is the wrong source for the same reason one
/// level up — a repainting TUI's raw bytes reconstruct to garbage; only the
/// terminal that has already interpreted them can answer "what does the
/// screen say right now".
///
/// ## Pure by construction
///
/// Takes a row count and a row-text accessor rather than a `Terminal` (the
/// same shape as `scrollback_window.dart` / `attach_overlap.dart`), so the
/// rule is unit-testable with no Flutter, no PTY and no xterm dependency of
/// its own.
library;

/// How many rows to examine, counting back from the LAST NON-BLANK ROW, when asking
/// whether the screen ends in the composer (#210). Inclusive of that row: 8 means the
/// caret may sit up to 7 rows above the last row that has content.
///
/// A bound is needed at all because Claude's TUI renders INLINE, not on the alternate
/// screen — #146 measured that twice, against the documentation's own claim. So a
/// previous frame's composer can still be visible ABOVE whatever is drawn now, and an
/// unbounded search would find it and call the screen idle while a dialog sits at the
/// bottom.
///
/// MEASURED, not chosen. `scripts/rig/probe-tail-strip.js` drove the real TUI and
/// `tool/tail_strip_report.dart` rendered each capture through this app's own xterm:
///
///   screen                     caret is N rows above the last non-blank row
///   -------------------------  ------------------------------------------
///   idle, 120 cols              3
///   idle, 52 cols               4     <- a phone; the footer gains a row here
///   slash menu, `/usa`          9     <- THE BINDING CASE (see below)
///   slash menu, `/usage`       14
///   slash menu, bare `/`       16
///   Agent View                 20
///   /usage panel                    no caret on screen at all
///   slash menu, `/zzzq`         2     <- no matches, so NO MENU: an ordinary composer
///
/// **The narrowed menu is what sets the ceiling, and measuring only the bare `/` menu
/// would have missed it** — review caught that, and it was right to. Bare `/` is the
/// menu at its TALLEST: its ~16 entries are the only reason the caret sits outside any
/// sane window. Type a few characters, the list filters, and the caret comes back down
/// to 9. A first cut of this constant sat at 8 and cleared that case by a single row.
///
/// So the measured bound is **[5, 8]**: at least the widest idle footer seen (4, plus a
/// row for an update notice, which the rig captures did not all carry), and strictly
/// under the narrowed menu's 9. 7 is the balanced choice inside it — three rows of
/// headroom above the idle footer, two rows of clearance below the menu.
///
/// The `/zzzq` row is not a counter-example: with nothing matching, Claude draws no menu
/// at all and the screen IS an ordinary composer with text in it, where Enter submits
/// normally. Hiding the strip there is correct, not a miss.
///
/// GETTING IT WRONG IS NOT SYMMETRIC, and the two costs are not equal:
///   * too SMALL — the composer is missed and the strip shows the footer, which is
///     exactly the complaint #210 fixed: no worse than the behaviour before it.
///   * too LARGE — the strip hides on a narrowed slash menu, or on a stale composer
///     above a live dialog. Bounded (the draft is in the compose bar and the person is
///     mid-composition; #179's verifier deliberately does not watch `/`-lines either),
///     but it is a real regression against the old behaviour rather than a no-op.
const int kComposerScanRows = 7;

/// Does the visible screen END in the agent's ordinary composer — i.e. is the terminal
/// merely sitting at its prompt, showing nothing the chat lens is not already showing?
///
/// This is the whole of #210. [terminalTailLines] answers *what are the last few rows*,
/// and while a composer is up that answer is **always the same footer**: Claude ends
/// every such screen with the composer box's bottom border, the mode hint, the status
/// line and any update notice. So the strip rendered four rows of unchanging furniture
/// on every idle session — least informative in precisely the state its own gate
/// selects for.
///
/// ## This is not the classifier #179 ruled out
///
/// #179 measured that a detector for *blocked* is permanently incomplete: `/usage`, an
/// open slash menu and Agent View each swallow a submitted prompt and NOT ONE of them
/// emits a distinguishing byte. That argument is about recognising an open-ended set.
/// This recognises exactly ONE thing, the composer, and it recognises it in order to
/// stay QUIET. Everything else — every dialog, every unmeasured future state, every
/// agent that declares no marker — falls through to the tail exactly as before. **The
/// failure direction is showing the terminal, never hiding it**, which is the opposite
/// of a classifier's.
///
/// [composer] is the marker from `GET /api/agents` (`AgentInfo.composerPattern`), never
/// a constant of this app's own: the server's registry owns it, gates submits with the
/// same one (#147), and measured it (#190) across widths and permission modes —
/// including the finding that Claude's folder-trust dialog draws the same caret WITHOUT
/// the NO-BREAK SPACE, which is the whole reason a bare caret cannot serve. Null means
/// no marker, and null answers **false**: show the tail.
///
/// [rowText] must be the RENDERED row, exactly as for [terminalTailLines]. That the
/// marker survives rendering is measured rather than assumed — writing caret+NBSP
/// into the vendored xterm and reading the row back through `getText()` returns code
/// units [10095, 160], so caret+U+0020 still fails to match after a round trip through
/// a terminal buffer.
bool terminalEndsInComposer({
  required int rowCount,
  required String Function(int index) rowText,
  required RegExp? composer,
  int scanRows = kComposerScanRows,
}) {
  if (composer == null || rowCount <= 0 || scanRows <= 0) return false;

  // ANCHOR ON THE LAST ROW WITH CONTENT, never on the bottom of the viewport. The first
  // cut of this counted up from `rowCount - 1` and the rig falsified it on its first run:
  // a real idle screen put its content in rows 0..12 of a 30-row viewport, so the caret
  // sat at row 9 with SEVENTEEN blank rows below the footer. Counting from the viewport
  // floor never reached it at any window size, and the whole rule was a silent no-op.
  //
  // The screen's height is a property of the WINDOW; where the content ends is a property
  // of the SCREEN. Only the second one this question is about. It is the same
  // anchor-on-content lesson #167/#178 recorded for scrollback paging, arriving from a
  // different direction.
  var last = -1;
  for (var i = rowCount - 1; i >= 0; i--) {
    if (rowText(i).trim().isNotEmpty) {
      last = i;
      break;
    }
  }
  if (last < 0) return false; // a blank screen ends in nothing at all

  final stop = last - scanRows + 1;
  for (var i = last; i >= 0 && i >= stop; i--) {
    if (composer.hasMatch(rowText(i))) return true;
  }
  return false;
}

/// How many lines the strip shows. Small on purpose — this is a peek that
/// earns a tap through to the terminal lens, not a second terminal.
const int kTerminalTailLines = 4;

/// Which slice of a buffer's `lines` is the VISIBLE SCREEN: `base` is the index
/// of the top visible row, `rows` is how many there are.
///
/// This exists as a rule rather than as two expressions at the call site for
/// two reasons, and review found both the hard way.
///
/// **It is the one indexing rule, so it must have one owner.** A test that
/// hand-copies `buffer.scrollBack + i` is a second copy of it, and then cannot
/// catch a bug in the first — which is exactly what happened: the trust-dialog
/// fixture left `scrollBack == 0`, so an implementation reading
/// `buffer.lines[i]` (the TOP of scrollback — ancient content on any
/// long-lived session) passed every test in the change that introduced it.
///
/// **And it is CLAMPED.** `lines.length >= viewHeight` is a documented
/// invariant of the vendored Buffer, but the caller runs from
/// `notifyListeners()` INSIDE `Terminal.write`, and #81 is this repo's
/// recorded case of a throw on that path escaping into a WebSocket listener
/// and killing the widget subtree in release — the blank-terminal symptom. We
/// vendor and PATCH that library, and #81 was the library contradicting its
/// own assumptions.
///
/// The clamp never answers *wrongly*, only *smaller*: with `lineCount >=
/// viewHeight` it names exactly `(scrollBack, viewHeight)`; with a short
/// buffer it names `(0, lineCount)`, which IS the whole screen; with nothing
/// at all it names `(0, 0)` and the walk above returns empty.
({int base, int rows}) terminalTailWindow({
  required int lineCount,
  required int viewHeight,
}) {
  if (lineCount <= 0 || viewHeight <= 0) return (base: 0, rows: 0);
  final scrollBack = lineCount - viewHeight;
  final base = scrollBack < 0 ? 0 : scrollBack;
  final available = lineCount - base;
  return (base: base, rows: viewHeight < available ? viewHeight : available);
}

/// The last [maxLines] non-blank rows of the terminal's CURRENT SCREEN, in
/// their original top-to-bottom order.
///
/// [rowCount] is the number of rows to examine — pass the VIEWPORT height
/// (`buffer.viewHeight`), never the whole scrollback: what a blocked TUI is
/// asking is on screen NOW, and history above it does not answer that
/// question. Row 0 is the top of the visible screen; [rowText] must return
/// the text already rendered at that row
/// (`buffer.lines[buffer.scrollBack + index].getText()`) — see the library
/// doc above for why that, and not a raw byte stream, is what makes this work
/// at all.
///
/// A row counts as blank exactly the way the rest of this codebase already
/// decides it (the trailing-blank walk in `scrollback_window.dart`):
/// `.trim().isEmpty`.
///
/// **Blank rows are dropped wherever they occur, not merely at the tail.**
/// [maxLines] is small and fixed, and a TUI dialog routinely separates its
/// question from its option list with a blank row — counting that row
/// against the budget would silently push the options themselves off the top
/// of the strip. The point of the strip is "the last few lines that say
/// something", a blank row says nothing, and dropping it costs nothing:
/// nothing about interior spacing is preserved, only the order of the
/// content that remains.
List<String> terminalTailLines({
  required int rowCount,
  required String Function(int index) rowText,
  int maxLines = kTerminalTailLines,
}) {
  if (rowCount <= 0 || maxLines <= 0) return const [];
  final out = <String>[];
  for (var i = rowCount - 1; i >= 0 && out.length < maxLines; i--) {
    final text = rowText(i);
    if (text.trim().isEmpty) continue;
    out.add(text.trimRight());
  }
  return out.reversed.toList(growable: false);
}

/// What the chat lens's tail strip should render for this screen: the tail, or nothing.
///
/// **The screen calls THIS, not the two rules it composes**, and the reason is the one
/// this file already states for `terminalTailWindow`: a call site that re-derives the
/// composition is a second copy of it, and a test written against that copy passes while
/// the screen carries the bug. Here the composition is small enough to look harmless,
/// which is exactly when it gets retyped.
///
/// Empty means *render no strip at all* — and the caller must reserve no space for
/// one either. `TerminalTailStrip.heightFor(0)` is 0 for that reason.
List<String> terminalStripLines({
  required int rowCount,
  required String Function(int index) rowText,
  required RegExp? composer,
  int maxLines = kTerminalTailLines,
  int scanRows = kComposerScanRows,
}) {
  if (terminalEndsInComposer(
    rowCount: rowCount,
    rowText: rowText,
    composer: composer,
    scanRows: scanRows,
  )) {
    return const <String>[];
  }
  return terminalTailLines(
    rowCount: rowCount,
    rowText: rowText,
    maxLines: maxLines,
  );
}
