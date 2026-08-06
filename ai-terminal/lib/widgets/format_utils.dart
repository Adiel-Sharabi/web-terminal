/// Small, dependency-free formatting helpers shared by the dashboard and
/// session card widgets. No `intl` dependency is available, so all formatting
/// here is hand-rolled.
library;

import 'package:flutter/material.dart';

/// Context-window pressure thresholds — the SINGLE source of truth for the
/// ctx% color, shared by the session list ([SessionCard]) and the in-session
/// metrics header (conversation_view `_MetricsHeader`). Context fills fast and
/// matters most, so warn early (50%) and flag danger at 70%. Do not copy these
/// numbers into a call site; import [ctxColor] instead.
const int kCtxWarnPct = 50;
const int kCtxDangerPct = 70;

/// The one amber every pressure read uses. Defined once so ctx% and the usage
/// windows can never drift to two different "warning" colours.
const Color kWarnAmber = Color(0xFFE0A030);

/// Green below [kCtxWarnPct], amber up to [kCtxDangerPct], red at/above — the
/// quick context-pressure read shown everywhere a ctx% appears.
Color ctxColor(ThemeData theme, int pct) {
  if (pct >= kCtxDangerPct) return theme.colorScheme.error;
  if (pct >= kCtxWarnPct) return kWarnAmber;
  return theme.colorScheme.primary;
}

/// Rate-limit window pressure — the SINGLE source of truth for the 5h/7d
/// colours. As with [ctxColor], do not copy these numbers into a call site.
///
/// **The two windows are deliberately NOT read on the same scale.** The 5h
/// window refills inside a working session, so an early amber is actionable —
/// you can pace the next few hours. The weekly window is judged over days, and
/// warning at 60% cried wolf for most of a normal week: a colour that is amber
/// most of the time carries no information. Weekly therefore stays neutral
/// until 80%, and keeps a usable amber band before red at 90%.
const int kUsageWarnPct = 60;
const int kUsageDangerPct = 85;
const int kWeekUsageWarnPct = 80;
const int kWeekUsageDangerPct = 90;

/// Green below the warn point, amber up to danger, red at/above. [weekly]
/// picks the 7d scale over the 5h one — see the constants above for why they
/// differ.
Color usageColor(ThemeData theme, int pct, {required bool weekly}) {
  final danger = weekly ? kWeekUsageDangerPct : kUsageDangerPct;
  final warn = weekly ? kWeekUsageWarnPct : kUsageWarnPct;
  if (pct >= danger) return theme.colorScheme.error;
  if (pct >= warn) return kWarnAmber;
  return theme.colorScheme.primary;
}

/// Relative time per spec §2: `<60s "just now"; <1h "Nm ago"; <24h "Nh ago";
/// else "Nd ago"`. [epochMs] is milliseconds since epoch (as returned by the
/// API); `null` renders as `'—'`.
String relativeTime(int? epochMs, {DateTime? now}) {
  if (epochMs == null) return '—';
  final then = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final diff = (now ?? DateTime.now()).difference(then);
  if (diff.isNegative || diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}

/// Absolute local timestamp for the attention detail sheet, e.g.
/// `2026-07-05 14:32` (spec §3).
String absoluteTime(int? epochMs) {
  if (epochMs == null) return '—';
  final t = DateTime.fromMillisecondsSinceEpoch(epochMs);
  String pad(int n) => n.toString().padLeft(2, '0');
  return '${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}';
}

/// True when [name] looks like a path/filename (contains `/`, `~`, or `.`),
/// in which case spec §0.3 calls for a monospace font.
bool looksLikePath(String name) =>
    name.contains('/') || name.contains('~') || name.contains('.');
