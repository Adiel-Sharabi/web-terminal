/// #380 - a session's FAMILY: who opened it, and everything it opened, on every
/// machine.
///
/// The session list groups by machine, so a run spread over several machines (a
/// lead on one box opening workers on two others) is cut into pieces there, and a
/// session screen named no relatives at all. Three ways in, all drawn from
/// [SessionTree] over EVERY server's sessions:
///
///  * [FamilyBadge] - on a card: who opened it and how many it opened
///    ([familySummary]); on its own line, because a phone's title row has no
///    room left (measured: ~60dp of a 360dp row, leaving the name ~23dp).
///  * [FamilyStrip] - under a session screen's title: its ancestors, each one a
///    tap away, and the badge.
///  * [showFamilySheet] - the whole tree, live, with the session you came from
///    marked; tap any row to open it.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../util/session_tree.dart';
import 'app_bottom_sheet.dart';
import 'server_badge.dart';
import 'session_card.dart' show sessionDotStatus;
import 'status_dot.dart';

/// `↑1 ↓3`: ancestors and everything under [s]; empty when it has neither.
String familyCountLabel(SessionTree tree, Session s) {
  final up = tree.ancestorsOf(s).length;
  final down = tree.descendantsOf(s).length;
  return [if (up > 0) '↑$up', if (down > 0) '↓$down'].join(' ');
}

/// A card's family line: `↑ Master · XPS   ↓ 5 sub-sessions`. The parent is named,
/// with its machine when that is another one; what it opened is counted at any
/// depth. Empty when it has neither.
String familySummary(SessionTree tree, Session s) {
  final p = tree.parentOf(s);
  final down = tree.descendantsOf(s).length;
  return [
    if (p != null) '↑ ${p.displayName}${p.server.name == s.server.name ? '' : ' · ${p.server.name}'}',
    if (down > 0) '↓ $down sub-session${down == 1 ? '' : 's'}',
  ].join('   ');
}

/// [label] for a screen reader, which would read the arrows as "up arrow".
String spokenFamily(String label) => label
    .replaceAll('↑ ', 'opened by ')
    .replaceAll('↓ ', '')
    .replaceAll('↑', 'above: ')
    .replaceAll('↓', 'below: ')
    .replaceAll(' · ', ' on ');

/// Whether [s] has any relative still listed, on any machine.
bool hasFamily(SessionTree tree, Session s) =>
    tree.parentOf(s) != null || tree.childrenOf(s).isNotEmpty;

/// The tappable family marker: an icon and [label], which shortens rather than
/// overflows. Opens the family sheet.
class FamilyBadge extends StatelessWidget {
  const FamilyBadge({super.key, required this.label, required this.onTap});

  /// [familySummary] on a card, [familyCountLabel] in the strip.
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.primary;
    return Semantics(
      button: true,
      label: 'Family: ${spokenFamily(label)}. Show the related sessions',
      excludeSemantics: true,
      onTap: onTap,
      child: Tooltip(
        message: 'Related sessions, on every machine',
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppShape.small),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.account_tree_outlined, size: 14, color: color),
                const SizedBox(width: 3),
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(color: color),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The live session list: what the strip and the sheet are drawn from.
Widget _liveSessions(Widget Function(BuildContext, List<Session>) builder) {
  final repo = SessionRepository.instance;
  return StreamBuilder<List<Session>>(
    stream: repo.sessions,
    initialData: repo.current,
    builder: (context, snap) => builder(context, snap.data ?? const <Session>[]),
  );
}

Session? _byId(List<Session> all, String id) {
  for (final s in all) {
    if (s.id == id) return s;
  }
  return null;
}

/// Opens the family of session [sessionId] as a sheet. [onOpen] is how the caller
/// opens a session (a split pane selects, a phone pushes a route); the sheet
/// closes first.
Future<void> showFamilySheet(
  BuildContext context, {
  required String sessionId,
  required void Function(Session session) onOpen,
}) {
  return showAppBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => _liveSessions((context, all) {
      final theme = Theme.of(context);
      final here = _byId(all, sessionId);
      final tree = SessionTree(all);
      final rows = here == null ? const <SessionTreeRow>[] : tree.familyOf(here);
      final machines = {for (final r in rows) r.session.server.name};
      return ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.75),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.screenPadding, 0, AppSpacing.screenPadding, 8),
              child: Text(
                here == null
                    ? 'This session has ended'
                    : 'Family · ${rows.length} sessions'
                        '${machines.length > 1 ? ' on ${machines.length} machines' : ''}',
                style: theme.textTheme.titleMedium,
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final r in rows)
                    _FamilyRow(
                      row: r,
                      isHere: identical(r.session, here),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        if (!identical(r.session, here)) onOpen(r.session);
                      },
                    ),
                ],
              ),
            ),
          ],
        ),
      );
    }),
  );
}

class _FamilyRow extends StatelessWidget {
  const _FamilyRow({required this.row, required this.isHere, required this.onTap});

  final SessionTreeRow row;
  final bool isHere;
  final VoidCallback onTap;

  /// Deeper levels stop indenting, so a long chain keeps room for its names.
  static const int _maxLevels = 4;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = row.session;
    final repo = SessionRepository.instance;
    final level = row.depth > _maxLevels ? _maxLevels : row.depth;
    return InkWell(
      key: ValueKey('family-row-${s.id}'),
      onTap: onTap,
      child: Container(
        color: isHere ? theme.colorScheme.primary.withValues(alpha: 0.12) : null,
        padding: EdgeInsetsDirectional.only(
          start: AppSpacing.screenPadding + 18.0 * level,
          end: AppSpacing.screenPadding,
          top: 10,
          bottom: 10,
        ),
        child: Row(
          children: [
            if (row.depth > 0) ...[
              Icon(Icons.subdirectory_arrow_right, size: 14, color: theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 4),
            ],
            StatusDot(status: sessionDotStatus(s, repo.apiErrorFor(s.id))),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                s.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: isHere ? FontWeight.w700 : null,
                ),
              ),
            ),
            if (isHere) ...[
              Text('here', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.primary)),
              const SizedBox(width: 8),
            ],
            ServerBadge(
              name: s.server.name,
              color: colorFromHex(repo.serverColor(s.server.baseUrl)),
            ),
          ],
        ),
      ),
    );
  }
}

/// Under a session screen's title: the sessions above this one, each a tap away,
/// and the [FamilyBadge] for the whole tree. Nothing at all for a session with no
/// relatives.
class FamilyStrip extends StatelessWidget {
  const FamilyStrip({super.key, required this.sessionId, required this.onOpen});

  final String sessionId;
  final void Function(Session session) onOpen;

  @override
  Widget build(BuildContext context) {
    return _liveSessions((context, all) {
      final here = _byId(all, sessionId);
      if (here == null) return const SizedBox.shrink();
      final tree = SessionTree(all);
      if (!hasFamily(tree, here)) return const SizedBox.shrink();
      final theme = Theme.of(context);
      final muted = theme.colorScheme.onSurfaceVariant;
      final sep = Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Icon(Icons.chevron_right, size: 16, color: muted),
      );
      final up = tree.ancestorsOf(here).reversed.toList(growable: false);
      return Material(
        key: ValueKey('family-strip-$sessionId'),
        color: theme.colorScheme.surfaceContainerLow,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Row(
            children: [
              Expanded(
                // Scrolls rather than wraps, pinned to the END: on a phone the
                // nearest ancestor and this session stay in view.
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  reverse: true,
                  child: Row(
                    children: [
                      for (final a in up) ...[
                        _Crumb(
                          session: a,
                          // The machine is named where the chain crosses one.
                          showServer: a.server.name != here.server.name,
                          onTap: () => onOpen(a),
                        ),
                        sep,
                      ],
                      Text(
                        here.displayName,
                        style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FamilyBadge(
                key: ValueKey('family-badge-$sessionId'),
                label: familyCountLabel(tree, here),
                onTap: () => showFamilySheet(context, sessionId: sessionId, onOpen: onOpen),
              ),
            ],
          ),
        ),
      );
    });
  }
}

class _Crumb extends StatelessWidget {
  const _Crumb({required this.session, required this.showServer, required this.onTap});

  final Session session;
  final bool showServer;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = showServer ? '${session.displayName} · ${session.server.name}' : session.displayName;
    return Semantics(
      button: true,
      label: 'Open $text',
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
      key: ValueKey('family-crumb-${session.id}'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppShape.small),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
        child: Text(
          text,
          style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.primary),
        ),
      ),
      ),
    );
  }
}
