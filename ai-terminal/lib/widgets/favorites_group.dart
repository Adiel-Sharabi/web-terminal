/// Pinned "★ Favorites" section shown at the very top of the dashboard,
/// mirroring the web sidebar's `renderFavoritesGroup`: renders every
/// favorited session (across all servers), in the DERIVED pinned order (#60
/// — `Session.pinnedOrder`, sorted by `(favoriteRank, id)`), silently
/// dropping any session that isn't currently present (offline or killed)
/// rather than showing a placeholder for it.
///
/// The header is tappable (chevron + whole row) to collapse/expand the
/// group — the caller owns persisting that choice (mirrors the web
/// sidebar's collapsible groups); this widget just renders whatever
/// [collapsed] it's given and reports taps via [onToggleCollapsed].
///
/// Deliberately decoupled from `SessionRepository` — the caller passes the
/// merged [sessions] list and a [cardBuilder], so this widget is a plain,
/// stateless function of its inputs (favorite/favoriteRank ride on each
/// [Session] itself — there is no separate order to thread through) and
/// stays unit-testable without any service singleton.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';

class FavoritesGroup extends StatelessWidget {
  const FavoritesGroup({
    super.key,
    required this.sessions,
    required this.cardBuilder,
    required this.collapsed,
    required this.onToggleCollapsed,
    required this.onReorder,
  });

  /// The current merged session list (all servers). Each session's own
  /// `favorite`/`favoriteRank` fields (server truth) decide membership and
  /// order — see [Session.pinnedOrder].
  final List<Session> sessions;

  /// Builds the row for one favorited [Session] — the caller supplies this
  /// so favorites render with the exact same status/api-error treatment as
  /// the main list (typically a `SessionCard` with `isFavorite: true`).
  ///
  /// `reorderIndex` is this row's position in the group when the row itself
  /// must carry the grab affordance, and `null` when this widget wraps the
  /// row instead — see [_grabByHandle] for which platform gets which, and
  /// why. A non-null index means "render your drag handle for this index",
  /// which is the SAME `ReorderableDragStartListener` handle the caller
  /// already builds for a main-list row (#22) — the handle widget stays
  /// defined in exactly one place.
  final Widget Function(BuildContext context, Session session, int? reorderIndex)
  cardBuilder;

  /// Whether the group is currently collapsed (cards hidden, only the header
  /// shown). The caller owns and persists this.
  final bool collapsed;

  /// Called when the header is tapped to toggle [collapsed].
  final VoidCallback onToggleCollapsed;

  /// Called when a pinned row is dragged to a new slot (#124). `newIndex` is the
  /// FINAL index (`onReorderItem` semantics — already adjusted for the removed
  /// item), which is what `reorderedFavoriteRanks` expects. The caller persists
  /// the new ranks.
  ///
  /// This widget owns the LIST and decides where the grab target lives; on
  /// touch it owns only half the gesture, because the affordance itself is the
  /// caller's to render — a [cardBuilder] that ignores its `reorderIndex`
  /// silently yields a group that cannot be reordered on a phone at all. That
  /// join is covered by `dashboard_favorites_handle_test.dart`, which drives
  /// the real dashboard rather than a stand-in card.
  final void Function(List<Session> ordered, int oldIndex, int newIndex) onReorder;

  /// Whether a pinned row is grabbed by a HANDLE the card renders at its
  /// trailing edge (touch) or by the WHOLE ROW (pointer devices).
  ///
  /// **#169 — this overturns #124's choice on touch, so the reason lives here.**
  ///
  /// #124 wrapped the whole row in a [ReorderableDelayedDragStartListener] on
  /// touch, deliberately preferring long-press-to-grab over a handle, on the
  /// grounds that a handle in a compact group is easy to catch by accident while
  /// scrolling. On a real device that gesture never fired once: `SessionCard`
  /// binds the actions sheet to an `InkWell.onLongPress`, so pressing a pinned
  /// row arms TWO recognizers on the same pointer with the SAME
  /// `kLongPressTimeout` deadline — `LongPressGestureRecognizer` inside the card
  /// and `DelayedMultiDragGestureRecognizer` above it. The card's is deeper, so
  /// it enters the arena first, its timer is created first, it accepts first,
  /// and accepting rejects the drag. Long-press opened the actions sheet; no
  /// drag ever began.
  ///
  /// **No ordering trick leaves both gestures alive ON THE SAME PIXELS.**
  /// Neither recognizer needs the pointer to move — each commits at its own
  /// deadline — so whichever accepts first takes the pointer outright, and
  /// shortening the drag's delay only swaps which gesture is dead. That is a
  /// statement about one region of the screen, not a proof that no alternative
  /// exists: a listener nested DEEPER, over a sub-region of the row, does win
  /// there — but a sub-region with nothing drawn in it is an invisible handle,
  /// which is strictly worse than a visible one for the reporter, who did not
  /// know a pinned row could be reordered at all.
  ///
  /// Nor is keeping long-press-to-drag blocked by "the sheet becomes
  /// unreachable" — `dashboard_screen.dart` binds the same `openActions` to
  /// `onMoreTap`, so the visible ⋮ already carries it. It is rejected because
  /// it would leave the app with two reorder idioms and leave the row's own
  /// long-press meaning something different in the pinned group than
  /// everywhere else.
  ///
  /// So touch gets the affordance the main list has used since #22 — the same
  /// handle, in the same trailing slot of the same card, doing the same thing
  /// ("The handle (not the whole card) starts a reorder, so the card's
  /// long-press stays bound to the actions sheet", `dashboard_screen.dart`).
  /// One reorder idiom in the app instead of two, and a VISIBLE one: the
  /// reporter did not know a pinned row could be reordered at all, which an
  /// invisible gesture was never going to tell them. #124's accidental-grab
  /// worry is answered by the main list itself, which has shipped this handle
  /// on a far longer, denser list since #22 without one such report — and the
  /// handle is an 18px glyph in a 48dp-tall, 22dp-wide strip at the row's very
  /// edge, where #124's alternative was the entire row.
  ///
  /// **A handle is not enough on its own, and this is where the first cut of
  /// #169 went wrong.** [SessionCard] used to render it INSIDE the same
  /// `InkWell`, so the arena race above simply moved onto the handle's own
  /// pixels: press it and hold — the idiom #124 taught — and the sheet opened
  /// and no drag began. The handle now hangs outside that `InkWell`
  /// ([SessionCard.dragHandle]), which is what makes both idioms work: an
  /// immediate drag recognizer has no deadline of its own, so it takes the
  /// first movement whenever it comes.
  ///
  /// A pointer device has no collision to resolve — a mouse starts a drag by
  /// MOVING, and holding still is exactly what fires the long-press — so it
  /// keeps the whole row as the grab target and shows no handle at all. The
  /// desktop path is untouched by #169.
  bool get _grabByHandle => switch (defaultTargetPlatform) {
    TargetPlatform.android || TargetPlatform.iOS => true,
    _ => false,
  };

  @override
  Widget build(BuildContext context) {
    final favorites = Session.pinnedOrder(sessions);
    if (favorites.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    const goldColor = AppColors.favorite;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: onToggleCollapsed,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.screenPadding,
              12,
              AppSpacing.screenPadding,
              4,
            ),
            child: Row(
              children: [
                const Icon(Icons.star, size: 14, color: goldColor),
                const SizedBox(width: 6),
                Text(
                  'FAVORITES',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: goldColor,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.08,
                  ),
                ),
                const Spacer(),
                Text(
                  '${favorites.length}',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                Icon(
                  collapsed ? Icons.chevron_right : Icons.expand_more,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        if (!collapsed) ...[
          // shrinkWrap + never-scrollable: this list lives inside the dashboard's
          // own scroll view, so it must size to its children and let the page do
          // the scrolling. buildDefaultDragHandles is off because Flutter's own
          // default is the very bug #169 is about: a handle on desktop, and on
          // touch the whole row wrapped in a long-press drag listener that any
          // long-press inside the row beats (see [_grabByHandle]).
          ReorderableListView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            itemCount: favorites.length,
            // onReorderItem, not onReorder: it delivers newIndex ALREADY adjusted
            // for the removed item, which is what [reorderedFavoriteRanks] expects
            // and what the per-server reorder next door already uses.
            onReorderItem: (oldIndex, newIndex) =>
                onReorder(favorites, oldIndex, newIndex),
            itemBuilder: (context, i) => KeyedSubtree(
              // ReorderableListView needs a stable key per row, and the card's own
              // key is the caller's business — so key the wrapper by session id.
              key: ValueKey('fav-reorder-${favorites[i].id}'),
              // Touch: hand the index to the card so its own handle starts the
              // drag, and put NO listener around the row — a wrapper here is what
              // raced the card's long-press (#169). Pointer: the whole row is the
              // target and the card renders no handle.
              //
              // A LONE favorite gets neither: the handle costs a pinned name
              // ~18% of its width, and with nowhere to drag to it would buy a
              // control that can never do anything. Withholding the index (not
              // the row) keeps the plumbing identical — the list still has one
              // item at index 0, it simply has no grab target.
              child: _grabByHandle
                  ? cardBuilder(
                      context,
                      favorites[i],
                      favorites.length > 1 ? i : null,
                    )
                  : ReorderableDragStartListener(
                      index: i,
                      child: cardBuilder(context, favorites[i], null),
                    ),
            ),
          ),
          const Divider(height: 16),
        ],
      ],
    );
  }
}
