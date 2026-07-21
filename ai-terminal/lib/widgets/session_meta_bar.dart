/// The session's meta bar (#74) — the row under the app bar carrying the
/// working directory, the usage badges, and the session's own controls.
///
/// **Why it exists at this level.** These chips used to live inside the chat
/// lens (`conversation_view`'s `_MetricsHeader`), which meant a terminal-lens
/// session showed no cwd and no ctx% at all. Worse, the controls that belong to
/// the *session* — lens toggle, read-aloud, which server it is on — were crammed
/// into the `AppBar`, where `actions` are laid out at their intrinsic width
/// FIRST and the title takes the leftover. The title was the only flexible
/// child, so it absorbed every control's shortfall and collapsed to `● Lo…`.
///
/// Moving them here fixes that structurally rather than by rationing pixels: the
/// app bar now carries only the title and the overflow, so a control added later
/// lands *here*, where the flexible child is the cwd — something that can shrink
/// harmlessly — instead of the session's name.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import 'format_utils.dart';
import 'server_badge.dart';

class SessionMetaBar extends StatelessWidget {
  const SessionMetaBar({
    super.key,
    required this.session,
    this.derivedCtx,
    this.controls = const <Widget>[],
  });

  final Session session;

  /// Approximate ctx% derived from the transcript when the live status line
  /// isn't posting; shown with a `~`. Null when a live ctx exists or none known.
  ///
  /// The chat lens is the only thing that can compute this (it holds the turns),
  /// so it is lifted up to this bar rather than dropped when the bar moved out
  /// of the chat lens.
  final int? derivedCtx;

  /// Session-level controls, right-aligned: lens toggle, read-aloud, server
  /// badge. Fixed width by nature — the cwd chip is what yields.
  final List<Widget> controls;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final m = session.metrics;
    final folder = folderName(session.cwd);

    final chips = <Widget>[];
    if (folder.isNotEmpty) {
      chips.add(_chip(theme, Icons.folder_outlined, folder,
          theme.colorScheme.onSurfaceVariant));
    }
    // Which model (and effort) the session is actually talking to. Placed before
    // the numbers because it FRAMES them — `ctx 42%` means something different
    // against a 200k window than a 1M one — and rendered in the quiet variant
    // colour because, unlike the percentages, it is a stable property that does
    // not want the eye.
    //
    // Agent-neutral by construction: the server fills the same `model`/`effort`
    // for every provider (Claude from its status-line payload, Codex from its
    // rollout's turn_context), so this asks for a field, never for an agent.
    // Either half may be absent, so the label is whichever parts exist.
    final modelLabel =
        [m?.model, m?.effort].where((p) => p != null && p.isNotEmpty).join(' · ');
    if (modelLabel.isNotEmpty) {
      chips.add(_chip(theme, Icons.psychology_outlined, modelLabel,
          theme.colorScheme.onSurfaceVariant));
    }
    // Context fills fast and matters most — warn early (50%), danger at 70%.
    // Prefer the live status-line value; fall back to the transcript estimate.
    if (m?.ctx != null) {
      // Shared SSOT thresholds via ctxColor — the same helper the session list
      // uses, so the two surfaces can never drift apart.
      chips.add(_chip(theme, Icons.data_usage, 'ctx ${m!.ctx}%',
          ctxColor(theme, m.ctx!)));
    } else if (derivedCtx != null) {
      chips.add(_chip(theme, Icons.data_usage, 'ctx ~$derivedCtx%',
          ctxColor(theme, derivedCtx!)));
    }
    if (m?.fiveH != null) {
      chips.add(_chip(theme, Icons.schedule, '5h ${m!.fiveH}%',
          _loadColor(theme, m.fiveH!, 60, 85)));
    }
    if (m?.sevenD != null) {
      chips.add(_chip(theme, Icons.calendar_today, '7d ${m!.sevenD}%',
          _loadColor(theme, m.sevenD!, 60, 85)));
    }

    // With neither chips nor controls there is nothing to show — collapse
    // entirely rather than leave an empty strip.
    if (chips.isEmpty && controls.isEmpty) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(color: theme.dividerColor.withValues(alpha: 0.4)),
        ),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final chipRow = SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: chips),
          );
          // One row only when both sides genuinely fit. Sharing a row on a phone
          // does not "compress" the badges — the scroll view hides the overflow
          // SILENTLY, which is how 7d disappeared entirely and 5h was left
          // clipped mid-number. Numbers that are half-visible are worse than
          // numbers on their own line.
          if (constraints.maxWidth >= kMetaBarSingleRowWidth ||
              controls.isEmpty) {
            return Row(
              children: [
                Expanded(child: chipRow),
                if (controls.isNotEmpty) const SizedBox(width: 8),
                ...controls,
              ],
            );
          }
          // Narrow: the badges get the full width and the controls take their
          // own line. Costs one thin row; shows every number.
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              chipRow,
              const SizedBox(height: 2),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: controls),
            ],
          );
        },
      ),
    );
  }

  /// The last path segment of [cwd] — the folder name the user recognises.
  static String folderName(String cwd) {
    if (cwd.isEmpty) return '';
    final parts =
        cwd.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty).toList();
    return parts.isEmpty ? cwd : parts.last;
  }

  // Green below [warn], amber to [danger], red at/above — quick pressure read.
  static Color _loadColor(ThemeData theme, int pct, int warn, int danger) {
    if (pct >= danger) return theme.colorScheme.error;
    if (pct >= warn) return const Color(0xFFE0A030);
    return theme.colorScheme.primary;
  }

  static Widget _chip(
      ThemeData theme, IconData icon, String label, Color color) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: color),
          const SizedBox(width: 4),
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: color,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

/// The server chip as it appears in the meta bar.
class MetaServerBadge extends StatelessWidget {
  const MetaServerBadge({super.key, required this.name});
  final String name;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: 4),
        child: ServerBadge(name: name),
      );
}

/// Below this width the badges and the controls get their own rows.
///
/// Measured against the real content, not guessed: on a 360px phone the chips
/// (`MobileClient · ctx 93% · 5h 34% · 7d 76%`) need roughly 280px and the
/// controls roughly 200px. They cannot share a 336px content box, and forcing
/// them to does not shrink anything — it pushes the trailing badges out of a
/// horizontal scroll view where nothing signals they exist.
const double kMetaBarSingleRowWidth = 560;

/// Shape token re-export guard — keeps the analyzer honest about the import.
const double kMetaBarRadius = AppShape.small;
