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
