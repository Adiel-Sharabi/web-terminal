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

/// Memory headroom pressure (#165) — the SINGLE source of truth for the free-RAM
/// colour, keyed on the ABSOLUTE byte count and never on the percentage.
///
/// The percentage cannot carry this judgement: 98% used on a 32 GB box leaves
/// 0.65 GB and is unusable, while 98% on a very large box still leaves room to
/// work. Above roughly 90% the percentage has almost no dynamic range left, and
/// picking a box is the entire purpose of the readout.
///
/// **PROVISIONAL.** The only observations behind these numbers are 0.65 GB (a
/// box that was effectively unusable) and 12.7 GB and up (boxes that were fine),
/// with NOTHING in between — so they are a guess, recorded as one rather than
/// dressed up as measured. 2 GB is picked because it is roughly "can a build
/// even start here" (a Gradle daemon defaults to `-Xmx2048m`). Revisit against a
/// box observed in the middle of the range; do not quietly re-tune on a hunch.
const int kHeadroomRedBytes = 2 * 1024 * 1024 * 1024;
const int kHeadroomAmberBytes = 4 * 1024 * 1024 * 1024;

/// Error below [kHeadroomRedBytes], amber below [kHeadroomAmberBytes], and
/// `null` — meaning "inherit, no colour" — above it or when unknown.
///
/// Neutral rather than green on a healthy box, deliberately: this readout sits
/// on one dense line beside CPU and web-terminal's own footprint, and a line
/// where several things are always coloured is a line nobody reads. A dash is
/// not a warning either, so unknown is never tinted.
Color? headroomColor(ThemeData theme, int? availBytes) {
  if (availBytes == null || availBytes < 0) return null;
  if (availBytes < kHeadroomRedBytes) return theme.colorScheme.error;
  if (availBytes < kHeadroomAmberBytes) return kWarnAmber;
  return null;
}

/// A byte count for a glance: `1.4 GB`, `683 MB`, or `—` when unknown (#152).
///
/// Deliberately coarse. These figures come from a sampled process tree and are
/// used to answer "which box, which session" — three decimal places would
/// suggest a precision the sampling does not have. `null` renders as a dash and
/// never as `0`, because a blank reading and an idle one are different facts.
String formatBytesShort(int? bytes) {
  if (bytes == null || bytes < 0) return '—';
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) return '${(bytes / gb).toStringAsFixed(1)} GB';
  if (bytes >= mb) return '${(bytes / mb).round()} MB';
  return '${(bytes / 1024).round()} KB';
}

/// A percentage for a glance: `18%`, `0.4%` below 10, or `—` when unknown.
/// Sub-1% detail is kept because an agent sitting at 0.4% and one at 0% are
/// different, and rounding the first to `0%` would say the session is doing
/// nothing at all.
String formatPctShort(num? pct) {
  if (pct == null) return '—';
  if (pct >= 10) return '${pct.round()}%';
  final oneDp = (pct * 10).round() / 10;
  return oneDp == oneDp.roundToDouble() ? '${oneDp.round()}%' : '$oneDp%';
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

/// Wall-clock time only, e.g. `14:32` (#137).
///
/// Deliberately absolute rather than a "in 2h 14m" countdown: the resume time IS
/// absolute, so a clock reading stays true between polls where a relative one
/// silently rots — and keeping it honest would need a per-second ticker, which is
/// exactly the cost PR #107 measured and removed from this app.
String clockTime(int? epochMs) {
  if (epochMs == null) return '';
  final t = DateTime.fromMillisecondsSinceEpoch(epochMs);
  String pad(int n) => n.toString().padLeft(2, '0');
  return '${pad(t.hour)}:${pad(t.minute)}';
}

/// True when [name] looks like a path/filename (contains `/`, `~`, or `.`),
/// in which case spec §0.3 calls for a monospace font.
bool looksLikePath(String name) =>
    name.contains('/') || name.contains('~') || name.contains('.');
