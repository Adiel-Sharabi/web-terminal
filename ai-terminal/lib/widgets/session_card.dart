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
import '../services/favorite_toggle.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import 'attention_chip.dart';
import 'format_utils.dart';
import 'resource_stats.dart';
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
    this.onRecapTap,
    this.onMoreTap,
    this.onAutoResumeTap,
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

  /// Tapping the recap icon — opens the "where was I in this one?" sheet.
  /// `null` hides it. Deliberately NOT wired to [onTap]: the whole point is to
  /// look into a session without leaving the one you are in.
  final VoidCallback? onRecapTap;

  /// Tapping the trailing overflow (⋮) button — opens the same actions sheet
  /// as [onLongPress]. Long-press isn't always discoverable, so this gives
  /// every card a visible, tappable way in (spec: fork/rename/kill must be
  /// reachable without relying on a hidden gesture). `null` hides the button.
  final VoidCallback? onMoreTap;

  /// Tapping the 5h wait chip — turns auto-resume off (or back on) for this
  /// session (#137). `null` renders the chip as a plain label with no tap target,
  /// which is what a read-only surface wants.
  final VoidCallback? onAutoResumeTap;

  /// True when this row is the one shown in the split view's detail pane —
  /// draws a primary-colored outline so the active session is obvious.
  final bool selected;

  /// Optional drag handle (issue #22; `buildReorderDragHandle` is the one place
  /// it is built). The row is drag-reordered by the handle only — the
  /// whole-card long-press stays bound to the actions sheet. `null` (split
  /// view, an unreorderable row) shows no handle.
  ///
  /// **It is rendered as a SIBLING of the card's `InkWell`, never a descendant
  /// — and that is the whole feature, not a layout preference (#169).** Inside
  /// the `InkWell` the card's `onLongPress` owns the handle's own pixels, and
  /// both recognizers commit at the same `kLongPressTimeout` with no movement
  /// required, so a press-and-HOLD on the handle opened the actions sheet and
  /// started no drag. Only press-and-move worked — which is why the main list
  /// got away with it from #22 until #169 put the same handle on a group whose
  /// users had been taught to press and hold. Keep the handle out of the
  /// `InkWell`'s subtree and both idioms work.
  ///
  /// Sibling, but **overlaid, never inserted** — see [_withDragHandle] for why
  /// laying the two out side by side costs the card both its second row's width
  /// and its right-hand tap target.
  final Widget? dragHandle;

  /// Vertical inset that keeps a trailing [dragHandle]'s 18dp glyph level with
  /// the title row's icons now that it hangs outside the card's `InkWell` (and
  /// so no longer rides that `Row`'s centre alignment):
  /// `listRowVertical (12) + (titleRowHeight (24) − glyph (18)) / 2 = 15`.
  ///
  /// Doubling as the handle's own padding is what gives it a **48dp-tall touch
  /// target** — Material's minimum — for free: the strip is shorter than the
  /// card, so the row does not grow, and the glyph does not move. Pinned by
  /// `session_card_test.dart` ("the handle stays level with the ⋮ button").
  static const double dragHandleInset = 15;

  /// How much horizontal room a trailing [dragHandle] needs, expressed once so
  /// the title row's reservation and `buildReorderDragHandle`'s own build can
  /// never disagree: the 18dp glyph plus the 4dp gap that separates it from the
  /// ⋮ button. Pinned by `session_card_test.dart` ("the reserved strip is
  /// exactly as wide as the handle").
  static const double dragHandleGlyph = 18;
  static const double dragHandleGap = 4;
  static const double dragHandleWidth = dragHandleGap + dragHandleGlyph;

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
      child: _withDragHandle(InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          // Unconditional, and direction-neutral: a handle is painted OVER this
          // padding by [_withDragHandle], never inserted beside it, so the body
          // keeps the full width of the card whether or not the row has one.
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
                  // The strip [_withDragHandle] paints the handle into. The
                  // TITLE row reserves it and no other row does — the handle
                  // sits on this line, and the ones below it never contained
                  // it. Reserving it card-wide (which is what giving up the
                  // body's right padding amounted to) silently narrowed the
                  // status/star/timestamp row by this much on every handled
                  // row of the MAIN list too, and made it overflow.
                  if (dragHandle != null)
                    const SizedBox(width: dragHandleWidth),
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
                    // #137 — sitting out the 5h usage window. Placed here, directly
                    // after the status word and before the capacity numbers,
                    // because it QUALIFIES what the session is doing rather than
                    // measuring it. Renders the server's derived usageLimit and
                    // decides nothing itself — see UsageLimit's doc comment.
                    if (session.usageLimit?.waiting == true) ...[
                      if (label.isNotEmpty && !hasApiError)
                        const SizedBox(width: 8),
                      _WaitChip(
                        limit: session.usageLimit!,
                        onTap: onAutoResumeTap,
                      ),
                    ],
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
                    // #152 level 3 — this session's own CPU and memory, summed
                    // over its WHOLE process tree (the agent runs several levels
                    // below the shell pid the session reports, so the pid's own
                    // numbers are about a megabyte and say nothing). Beside the
                    // other capacity figures because it measures the same kind of
                    // thing; renders nothing at all unless the resources view is
                    // on, because the number behind it costs a process query.
                    SessionResourceChip(
                      baseUrl: session.server.baseUrl,
                      sessionId: session.id,
                    ),
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
                    if (onRecapTap != null)
                      _IconTapTarget(
                        icon: Icons.chat_outlined,
                        tooltip: 'Recap: last prompt and what it has been doing',
                        onTap: onRecapTap,
                      ),
                    if (onBellTap != null)
                      _IconTapTarget(
                        icon: _bellIcon(session.notifyLevel),
                        tooltip: 'Notify level: ${session.notifyLevel}',
                        onTap: onBellTap,
                      ),
                    if (onToggleFavorite != null)
                      _IconTapTarget(
                        icon: favoriteStarIcon(isFavorite),
                        iconColor: isFavorite
                            ? AppColors.favorite
                            : theme.colorScheme.onSurfaceVariant,
                        tooltip: favoriteStarTooltip(isFavorite),
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
      )),
    );
  }

  /// Paints [dragHandle] OVER the card's `InkWell` rather than beside it —
  /// outside its subtree (which is the feature, see [dragHandle]) but not
  /// outside its box.
  ///
  /// **A `Row[ Expanded(body), handle ]` is the obvious shape and is wrong
  /// twice.** It takes the strip out of the body, so every row of the card
  /// narrows — but only the TITLE row ever held the handle, so the status /
  /// star / timestamp row below simply loses [dragHandleWidth] and starts
  /// overflowing. And it makes the 16dp gutter a SIBLING of the `InkWell`
  /// instead of part of it, so roughly a tenth of the card's width stops
  /// opening the session and the ink ripple stops short of the edge. Both
  /// costs land on the main per-server list as well, because the card is
  /// shared. The `Stack` has neither: the body keeps the card's full width and
  /// the whole of its own padding, the title row alone reserves the strip
  /// ([dragHandleWidth], above), and only the handle's own 22x48 box is
  /// subtracted from the `InkWell` — which is exactly the pixels that must not
  /// carry a long-press.
  ///
  /// `top: 0` is what puts the glyph on the title line: [dragHandleInset] is
  /// sized from the card's own top, so the handle's centre lands on the ⋮.
  /// The `Stack` sizes itself to [body] (the only non-positioned child), so a
  /// handle can never make a row taller. `PositionedDirectional` so the strip
  /// follows text direction, like the padding it overlays.
  Widget _withDragHandle(Widget body) {
    final handle = dragHandle;
    if (handle == null) return body;
    return Stack(
      children: [
        body,
        PositionedDirectional(
          top: 0,
          end: AppSpacing.listRowHorizontal,
          child: handle,
        ),
      ],
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

/// #137 — "this session is waiting out its 5-hour window, and here is when it
/// comes back". Tapping switches auto-resume off for the session (and on again).
///
/// Two states, and the difference is load-bearing: `resumes 14:32` promises
/// something will happen, `on hold` says nothing will. Showing the first for a
/// session whose resume the user switched off would be the badge lying about the
/// timer — the exact class of disagreement #137 exists to remove.
class _WaitChip extends StatelessWidget {
  const _WaitChip({required this.limit, this.onTap});

  final UsageLimit limit;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final on = limit.enabled;
    final color = on ? StatusColor.capped : theme.colorScheme.onSurfaceVariant;
    final at = clockTime(limit.resumeAt);
    // "resumes" is keyed on ARMED, not on waiting: the cap prompt can be seen before
    // any reset time is known, and the worker cannot arm a timer without one — so
    // saying "resumes" then would promise something nothing is scheduled to do.
    final text = (on && limit.armed && at.isNotEmpty) ? 'resumes $at' : 'on hold';
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.pause_circle_outline, size: 11, color: color),
          const SizedBox(width: 3),
          Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: color,
              fontWeight: FontWeight.w600,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return Semantics(label: text, child: chip);
    return Tooltip(
      message: !on
          ? '5-hour limit reached. Auto-resume is off for this session. Tap to turn it back on.'
          : (limit.armed && at.isNotEmpty
              ? '5-hour limit reached. This session resumes on its own at $at. Tap to turn auto-resume off.'
              : '5-hour limit reached. This session will resume on its own once the reset time is known. Tap to turn auto-resume off.'),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(7),
        child: chip,
      ),
    );
  }
}
