/// Small, dependency-free formatting helpers shared by the dashboard and
/// session card widgets. No `intl` dependency is available, so all formatting
/// here is hand-rolled.
library;

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
