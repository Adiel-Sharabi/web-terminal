# Vendored `xterm` 4.0.0 — local patches (#81, #127, #151)

This is stock **xterm 4.0.0** (`lib/` only, from the pub cache) plus the fixes
below. It is wired in by `dependency_overrides` in `ai-terminal/pubspec.yaml`.

Every patched hunk is marked `WEB-TERMINAL PATCH (#<issue>)`. **Grep for that
marker before re-vendoring** — a re-vendor that drops one silently reintroduces
its bug.

```
grep -rn "WEB-TERMINAL PATCH" lib/
```

## Why this exists

xterm 4.0.0 is the **latest published release**, so there is nothing to upgrade to.

`Buffer.scrollUp`, `Buffer.scrollDown` and `Buffer.deleteLines` shifted a line with

```dart
lines[to] = lines[from];
```

That does not *move* the line — it leaves the same object referenced by **both**
slots. `IndexAwareCircularBuffer._adoptChild` unconditionally detaches whatever
occupied the destination, so the next iteration of the loop detaches the line the
previous iteration had just moved. Instrumenting the buffer showed the cascade, on a
buffer nowhere near full (`len=30 arr=5000`):

```
WT-DUP adopt index=29 cyc=29 already at slot=28 ...
WT-DUP adopt index=28 cyc=28 already at slot=27 ...   (all the way down to slot 0)
```

One defect, two symptoms — which is why it read as two separate bugs:

* The detached lines are still in the backing array, so the painter still draws
  them. But `TerminalController.selection` is null the moment *either* anchor is
  detached — hence **"text is visible but nothing selects"**, exactly as #81 reports.
* A later `_moveChild` calls `_move` on one of those detached lines, dereferencing
  `_owner!`. In debug that is the `assert(attached)` at `circular_buffer.dart:312`;
  in a **release** build the assert is compiled out and it becomes a hard null-check
  throw out of `Terminal.write` — called from a WebSocket stream listener, so it
  takes the widget subtree with it and the terminal goes **blank**.

It only bites Codex because those three methods are reached only inside a DECSTBM
vertical margin, and the Codex TUI sets 12 scroll regions on startup where Claude's
TUI sets none.

`Buffer.insertLines`, immediately above `deleteLines`, already avoided the alias by
going through `lines.swap`. So this is an upstream oversight, not a design decision.

## The patch

1. `lib/src/utils/circular_buffer.dart` — **adds** `IndexAwareCircularBuffer.move`,
   a genuine move built on the existing private `_moveChild` (which nulls the source
   slot). No stock behaviour is changed. It deliberately leaves a hole at the source;
   all three call sites shift a contiguous range and then refill the vacated rows.
2. `lib/src/core/buffer/buffer.dart` — `scrollDown`, `scrollUp` and `deleteLines` use
   `lines.move(from, to)` instead of `lines[to] = lines[from]`.

A `swap`-based fix would also have worked but allocates a throwaway `BufferLine` per
row per scroll, on the hottest path in the terminal. `move` is allocation-free.

### A second, unrelated patch (#127)

3. `lib/src/utils/circular_buffer.dart` — **adds**
   `IndexAwareCircularBuffer.prependAll`. Also purely additive; no stock behaviour
   is changed.

   Upstream can only reach the front through `insert(0, …)`, which is unusable for
   this twice over. It shifts every existing element with `_moveChild`, so prepending
   N items into a list of length L costs O(N × L) — thousands by thousands is tens of
   millions of moves. And on a **full** ring it returns early and silently does
   nothing at all, which is exactly what the "grows past its original cap" test
   catches when you swap the patch body for `insertAll(0, items)`.

   `prependAll` is O(N) because an element's index is *derived*, never stored:
   `IndexedItem.index` is `_absoluteIndex - _owner._absoluteStartIndex`, so lowering
   `_absoluteStartIndex` shifts every existing element down in one arithmetic step.
   Capacity is taken first via the existing `maxLength` setter, deliberately —
   growing reallocates from index 0 and leaves the free slots at the END of the
   array, which is what makes walking `_startIndex` backwards land on empty slots
   instead of overwriting live elements at the other end of the ring.

   **Ownership caveat, and it is the #81 defect again.** The elements prepended come
   from a scratch terminal that parsed the older text. `_adoptChild` re-owns them,
   so that scratch buffer must be discarded and never read again — a line reachable
   from two buffers is precisely what produced "text visible, nothing selects" and
   the release-mode blank terminal. `ai-terminal/test/xterm_prepend_test.dart` asserts
   attachment, index consistency, and that `Terminal.write` still works afterwards.

### A third, unrelated patch (#151)

4. `lib/src/core/buffer/line.dart` — `BufferLine.getText` emits a **space** for a
   blank cell inside the requested span, where stock emitted nothing at all.

   Stock skipped every cell whose codePoint is 0. A terminal does not pad a gap
   with literal 0x20 — a column that was never written, or that was erased
   (ECH/EL), holds 0 — so every run of blank columns inside a selection vanished
   and the words on either side were concatenated. `alpha    beta` came off the
   clipboard as `alphabet`, and indented output lost its indentation. Shell text
   typed as one string survived (its spaces really are 0x20), which is why the
   defect read as intermittent: it is the TUI-drawn output — the boxes, the
   margins, the aligned columns — that is built out of cursor moves and erases,
   and that is what people copy.

   **A blank is emitted only once something after it in the span is emitted.**
   That is what keeps the unwritten remainder of a row out of the result;
   without it every line of a multi-line selection would be padded out to the
   terminal width, because the segment for a line in the middle of the range
   spans the WHOLE line.

   **A literal 0x20 is deliberately NOT deferred** — it is a character the
   program wrote, not padding, and at the last column of a *wrapped* row it is
   load-bearing: the next row is joined with no newline, so trimming it deletes
   a space from the middle of a logical line. The first cut of this patch
   treated the two alike and turned `This is a long line` into
   `This is along line`; upstream's own `Buffer.getText() can handle line wrap`
   and `can handle block range` tests both caught it, which is the argument for
   running the parity check below rather than trusting our own suite.

   **The trap: a blank cell and the second half of a wide glyph are identical.**
   `Buffer.writeChar` follows a width-2 glyph with `writeChar(0)`, and
   `wcwidth(0) == 0`, so the continuation cell's content word is `0` — the exact
   value `eraseCell` writes. Nothing in the cell distinguishes them; only the
   LEFT NEIGHBOUR does (`getWidth(i - 1) == 2`). Emit a space for it and every
   CJK/emoji glyph grows a phantom space. The peek deliberately reaches one cell
   below `from`, so a selection that begins on a continuation cell does not open
   with one either.

   Regression test: `ai-terminal/test/xterm_gettext_whitespace_test.dart` —
   16 cases covering CUF and ECH gaps, indentation, the wrap rejoin, wide and
   astral glyphs beside real gaps, and the real capture replayed through
   `copyTerminalSelection`. Before the patch: `+7 -9`.

## How this was verified

* `ai-terminal/test/xterm_codex_stream_test.dart` — a real 13 KB Codex PTY capture is
  written whole and in 512-byte WebSocket-sized chunks; asserts no throw **and zero
  detached lines**, plus a margin-scroll unit case and a selection case that do not
  need the fixture. Before the patch this threw at byte 4381 of 13047 and left 27 of
  30 lines detached.
* `ai-terminal/test/terminal_write_guard_test.dart` — asserts zero dropped frames and
  a selectable buffer after the same stream.
* **Upstream's own suite was run against both copies.** Pristine and patched give the
  identical result — `+108 ~2 -2` — with the same two `TerminalView.textScaler`
  failures, which are pre-existing Flutter-SDK drift and unrelated. So the patch
  causes no upstream regression. **Re-run after adding `prependAll` (#127): still
  `+108 ~2 -2`, same two failures. Re-run after the `getText` change (#151):
  still `+108 ~2 -2`, same two failures — and it earned its keep, catching the
  first cut of that patch at `+106 ~2 -4`.**

To repeat that last check (the test suite is deliberately **not** vendored — it
cannot run in our CI and ships two known-failing tests):

```bash
cp -r "$PUB_CACHE/hosted/pub.dev/xterm-4.0.0/test" third_party/xterm/
# upstream's dev_dependencies do not resolve on a current SDK; drop these two:
#   dart_code_metrics: ^5.0.0
#   build_runner: ^2.1.1
cd third_party/xterm && flutter pub get && flutter test
rm -rf test .dart_tool pubspec.lock          # leave the vendored copy clean
```

## Upstream

Worth reporting to https://github.com/TerminalStudio/xterm.dart. Until a release
carries the fix, this vendored copy stays.
