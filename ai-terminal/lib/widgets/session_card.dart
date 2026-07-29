/// `SessionCard` — spec §2 `ListItem` layout, extended for feature parity
/// with the web sidebar's `.sb-item`:
///
/// ```
/// ┌──────────────────────────────────────────────┐
/// │  ●  Session Name              [Codex] [Home] │  ← agent chip only when Session.agent != null
/// │     Working        🔔 ☆        2m ago         │  ← status label + bell + star + time
/// │     [Needs approval ×]                        │  ← only when kind != null
/// └──────────────────────────────────────────────┘
/// ```
///
/// An active [apiError] (see `SessionRepository.apiErrorFor`) overrides the
/// whole card's styling — bright-red pulsing dot, red left-border highlight,
/// and the error text as a subtitle — exactly like the web's `.sb-item.api-error`.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../api/agent_catalog.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import 'attention_chip.dart';
import 'format_utils.dart';
import 'server_badge.dart';
import 'status_dot.dart';

class SessionCard extends StatelessWidget {
  const SessionCard({
    super.key,
    required this.session,
    this.attentionKind,
    this.apiError,
    this.isFavorite = false,
    this.onTap,
    this.onLongPress,
    this.onAttentionTap,
    this.onAttentionDismiss,
    this.onToggleFavorite,
    this.onBellTap,
    this.onMoreTap,
    this.selected = false,
    this.dragHandle,
  });

  final Session session;

  /// One of `approval` | `apierror` | `idle`, or `null` to hide the chip.
  final String? attentionKind;

  /// Live "stuck API error" state for this session (from
  /// `SessionRepository.apiErrorFor`), independent of [Session.status] — when
  /// [ApiErrorInfo.active] is true it overrides the card's dot/border/tint
  /// and surfaces [ApiErrorInfo.text] as a subtitle.
  final ApiErrorInfo? apiError;

  /// Whether this session is starred. The favorites group always passes
  /// `true` (its rows exist only because they are favorites); the main list
  /// looks this up per-session.
  final bool isFavorite;

  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onAttentionTap;
  final VoidCallback? onAttentionDismiss;

  /// Tapping the star — toggles favorite state. `null` hides the star.
  final VoidCallback? onToggleFavorite;

  /// Tapping the bell — opens the notify-level picker. `null` hides the bell.
  final VoidCallback? onBellTap;

  /// Tapping the trailing overflow (⋮) button — opens the same actions sheet
  /// as [onLongPress]. Long-press isn't always discoverable, so this gives
  /// every card a visible, tappable way in (spec: fork/rename/kill must be
  /// reachable without relying on a hidden gesture). `null` hides the button.
  final VoidCallback? onMoreTap;

  /// True when this row is the one shown in the split view's detail pane —
  /// draws a primary-colored outline so the active session is obvious.
  final bool selected;

  /// Optional drag handle (issue #22). The main list wraps a handle icon in a
  /// `ReorderableDragStartListener` so the row can be drag-reordered by the
  /// handle only — the whole-card long-press stays bound to the actions sheet.
  /// `null` (favorites, split view) shows no handle.
  final Widget? dragHandle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = sessionStatusFromString(session.status);
    final displayName = session.name.isEmpty
        ? 'Session ${session.shortId}'
        : session.name;
    final hasApiError = apiError?.active == true;
    // A live api-error override already screams for attention on its own —
    // don't also show the (redundant, status-derived) "API error" chip.
    final effectiveAttentionKind = hasApiError ? null : attentionKind;
    final dotStatus = hasApiError ? SessionStatus.apiError : status;
    final label = statusLabel(status);

    Color tint;
    Border border;
    if (hasApiError) {
      tint = StatusColor.apiError.withValues(alpha: 0.15);
      border = Border(left: BorderSide(color: StatusColor.apiError, width: 4));
    } else {
      switch (status) {
        case SessionStatus.apiError:
          tint = theme.colorScheme.errorContainer;
          border = Border(
            left: BorderSide(color: theme.colorScheme.error, width: 4),
          );
        case SessionStatus.waiting:
          tint = StatusColor.waiting.withValues(alpha: 0.08);
          border = Border.all(color: AppColors.outlineVariant);
        case SessionStatus.idle:
        case SessionStatus.active:
        case SessionStatus.working:
          tint = theme.colorScheme.surface;
          border = Border.all(color: AppColors.outlineVariant);
      }
    }
    if (selected) {
      tint = theme.colorScheme.primary.withValues(alpha: 0.10);
      border = Border.all(color: theme.colorScheme.primary, width: 2);
    }

    return Container(
      margin: const EdgeInsets.symmetric(
        horizontal: AppSpacing.screenPadding,
        vertical: 4,
      ),
      decoration: BoxDecoration(
        color: tint,
        borderRadius: BorderRadius.circular(AppShape.medium),
        border: border,
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.listRowHorizontal,
            vertical: AppSpacing.listRowVertical,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  StatusDot(status: dotStatus),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontFamily: looksLikePath(displayName)
                            ? 'monospace'
                            : null,
                        color: hasApiError
                            ? StatusColor.apiError
                            : null,
                        fontWeight: hasApiError ? FontWeight.w800 : null,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (session.agent != null) ...[
                    _AgentChip(agentId: session.agent!),
                    const SizedBox(width: 8),
                  ],
                  ServerBadge(name: session.server.name),
                  if (onMoreTap != null)
                    _IconTapTarget(
                      icon: Icons.more_vert,
                      tooltip: 'More actions',
                      onTap: onMoreTap,
                    ),
                  ?dragHandle,
                ],
              ),
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.only(left: 20),
                child: Row(
                  children: [
                    if (label.isNotEmpty && !hasApiError)
                      Text(
                        label,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: StatusColor.forStatus(status),
                        ),
                      ),
                    // #38 — live Claude context-window % (never recomputed;
                    // read straight off the session payload). Color via the
                    // shared ctxColor SSOT (warn 50 / danger 70). Absent/stale
                    // metrics.ctx → no badge.
                    if (session.metrics?.ctx != null) ...[
                      if (label.isNotEmpty && !hasApiError)
                        const SizedBox(width: 8),
                      Text(
                        '${session.metrics!.ctx}%',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: ctxColor(theme, session.metrics!.ctx!),
                          fontWeight: FontWeight.w600,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                    // A background command still running. It outlives the turn
                    // that launched it, so the dot beside it is honestly idle
                    // while a build is going — green alone reads as "nothing is
                    // happening". Amber matches the working dot so the two agree,
                    // without this pretending to BE a status.
                    if (session.backgroundTasks.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      Icon(Icons.sync, size: 12, color: StatusColor.working),
                      const SizedBox(width: 3),
                      Flexible(
                        child: Text(
                          session.backgroundTasks.length > 1
                              ? '${session.backgroundTasks.length} running'
                              : session.backgroundTasks.first,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: StatusColor.working,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                    const Spacer(),
                    if (onBellTap != null)
                      _IconTapTarget(
                        icon: _bellIcon(session.notifyLevel),
                        tooltip: 'Notify level: ${session.notifyLevel}',
                        onTap: onBellTap,
                      ),
                    if (onToggleFavorite != null)
                      _IconTapTarget(
                        icon: isFavorite ? Icons.star : Icons.star_border,
                        iconColor: isFavorite
                            ? const Color(0xFFF2C14E)
                            : theme.colorScheme.onSurfaceVariant,
                        tooltip: isFavorite
                            ? 'Remove from favorites'
                            : 'Add to favorites',
                        onTap: onToggleFavorite,
                      ),
                    const SizedBox(width: 4),
                    Text(
                      relativeTime(session.lastActivity),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              if (hasApiError && (apiError?.text?.isNotEmpty ?? false)) ...[
                const SizedBox(height: 4),
                Padding(
                  padding: const EdgeInsets.only(left: 20),
                  child: Text(
                    apiError!.autoContinue > 0
                        ? '${apiError!.text} — auto-recovering…'
                        : apiError!.text!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: StatusColor.apiError,
                    ),
                  ),
                ),
              ],
              if (effectiveAttentionKind != null) ...[
                const SizedBox(height: 8),
                Padding(
                  padding: const EdgeInsets.only(left: 20),
                  child: AttentionChip(
                    kind: effectiveAttentionKind,
                    onTap: onAttentionTap,
                    onDismiss: onAttentionDismiss,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The bell icon reflecting the session's per-session push level, mirroring
/// the web's 🔕/🔔/🔊 `NOTIFY_BELL` set.
IconData _bellIcon(String level) => switch (level) {
  'off' => Icons.notifications_off_outlined,
  'all' => Icons.notifications_active,
  _ => Icons.notifications_outlined,
};

final RegExp _hexColorRe = RegExp(r'^#[0-9a-fA-F]{6}$');

/// Parses a `#rrggbb` string into a [Color]; falls back to [fallback] when
/// [hex] is `null` or doesn't match the pattern, so a malformed or missing
/// color can never crash the chip.
Color parseAgentColor(String? hex, Color fallback) {
  if (hex == null || !_hexColorRe.hasMatch(hex)) return fallback;
  return Color(0xFF000000 | int.parse(hex.substring(1), radix: 16));
}

/// A small pill naming the AI CLI agent driving this session (Claude Code,
/// Codex, …), tinted with the agent's accent color. [SessionCard] instantiates
/// this only when [Session.agent] is non-null — a plain shell gets no chip.
///
/// Label and colour come from [AgentCatalog], which mirrors the server's
/// `GET /api/agents` registry — the SINGLE source of truth. The app deliberately
/// keeps no table of its own, so a CLI agent added server-side is chipped here with
/// no app release. An id the catalogue has not seen yet still renders (labelled with
/// the raw id, tinted with the theme default) rather than hiding the session.
class _AgentChip extends StatelessWidget {
  const _AgentChip({required this.agentId});

  final String agentId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final known = AgentCatalog.instance[agentId];
    final label = known?.label ?? agentId;
    final color = parseAgentColor(known?.color, theme.colorScheme.onSurfaceVariant);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(AppShape.small),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}

/// Small, tap-friendly icon button used for the bell/star row — compact
/// enough that both fit next to the timestamp without crowding the card.
class _IconTapTarget extends StatelessWidget {
  const _IconTapTarget({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.iconColor,
  });

  final IconData icon;
  final String tooltip;
  final Color? iconColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppShape.small),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
          child: Icon(
            icon,
            size: 16,
            color: iconColor ?? theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// Derives the card's attention kind straight from [Session.status] (the app
/// has no per-card `AttentionInfo` fetch on the list — that's reserved for
/// the on-demand attention detail sheet, and calling `/attention` per card
/// would be too chatty). Only REAL attention signals get a chip:
/// `waiting` → `approval`, `api_error` → `apierror`. Plain `idle` gets NO chip
/// — status alone can't tell "just finished" from "idle for days", so a "Done"
/// badge on every idle session is pure noise (the "Idle" status label already
/// says it). Matches the web, which badges only approval/api-error.
String? attentionKindForStatus(String status) {
  switch (status) {
    case 'waiting':
      return 'approval';
    case 'api_error':
      return 'apierror';
    default:
      return null;
  }
}
