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
          for (final session in favorites) cardBuilder(context, session),
          const Divider(height: 16),
        ],
      ],
    );
  }
}
