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
  final Widget Function(BuildContext context, Session session) cardBuilder;

  /// Whether the group is currently collapsed (cards hidden, only the header
  /// shown). The caller owns and persists this.
  final bool collapsed;

  /// Called when the header is tapped to toggle [collapsed].
  final VoidCallback onToggleCollapsed;

  /// Called when a pinned row is dragged to a new slot (#124). `newIndex` is the
  /// FINAL index (`onReorderItem` semantics — already adjusted for the removed
  /// item), which is what `reorderedFavoriteRanks` expects. The caller persists the
  /// new ranks; this widget owns only the gesture.
  final void Function(List<Session> ordered, int oldIndex, int newIndex) onReorder;

  /// Wraps one row in the grab gesture. Touch gets LONG-PRESS-then-drag rather
  /// than an always-on handle: a pinned row is compact, and a handle sitting in a
  /// dense group is easy to catch by accident while scrolling the dashboard. A
  /// pointer device has no such problem, so there the row drags directly. This is
  /// the same split the web sidebar uses (`app.html`, `attachFavReorder`).
  Widget _grabbable({required int index, required Widget child}) {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
      case TargetPlatform.iOS:
        return ReorderableDelayedDragStartListener(index: index, child: child);
      default:
        return ReorderableDragStartListener(index: index, child: child);
    }
  }

  @override
  Widget build(BuildContext context) {
    final favorites = Session.pinnedOrder(sessions);
    if (favorites.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    const goldColor = Color(0xFFF2C14E);

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
          // the scrolling. buildDefaultDragHandles is off because Flutter's default
          // would add its own handle icon on desktop and change the row's layout —
          // the whole row is the grab target instead (see [_grabbable]).
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
              child: _grabbable(
                index: i,
                child: cardBuilder(context, favorites[i]),
              ),
            ),
          ),
          const Divider(height: 16),
        ],
      ],
    );
  }
}
