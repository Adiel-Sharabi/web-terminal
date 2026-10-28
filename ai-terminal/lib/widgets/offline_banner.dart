/// Partial-offline banner — spec §2:
/// "⚠ {Server} is unreachable — sessions from this server may be stale"
/// (or "A and B are unreachable" for multiple), `ServerOffline` 12% bg +
/// 4dp left border.
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

class OfflineBanner extends StatelessWidget {
  const OfflineBanner({
    super.key,
    required this.offlineServerNames,
    this.needsAuthServerNames = const <String>[],
  });

  final List<String> offlineServerNames;

  /// Servers that answered **401** rather than failing to answer. Named
  /// separately because the two need opposite advice, and only one of them is
  /// actionable: an unreachable server may come back by itself, an expired
  /// token never will. App tokens carry a 90-day expiry and are pruned
  /// server-side once past it, so this is the ordinary end of a token's life,
  /// not a fault — and "unreachable" sends you to look at the network instead
  /// of at the one screen that fixes it.
  final List<String> needsAuthServerNames;

  /// The message - also the dashboard's down-badge tooltip (#402), and public
  /// so a test can assert the wording without pumping the widget.
  static String messageFor({
    required List<String> offline,
    required List<String> needsAuth,
  }) {
    // Auth LEADS when both are present: it is the only half the user can act
    // on, and a banner that reported a refused server as unreachable is what
    // made an expired token read as a network fault. But it no longer HIDES the
    // other half - a server that is genuinely down is still down, and a banner
    // naming only the 401 left it unreported until the token was fixed.
    // #402 - every server is NAMED, however many: a bare count ("2 servers are
    // unreachable") left the user unable to tell which ones.
    if (needsAuth.isNotEmpty) {
      final auth = needsAuth.length == 1
          ? '${needsAuth.first} needs sign-in — its token expired. Settings › Servers › ${needsAuth.first}'
          : '${joinNames(needsAuth)} need sign-in — their tokens expired. Settings › Servers';
      if (offline.isEmpty) return auth;
      final down = offline.length == 1
          ? '${offline.first} is unreachable'
          : '${joinNames(offline)} are unreachable';
      return '$auth. $down';
    }
    return offline.length == 1
        ? '${offline.first} is unreachable — sessions from this server may be stale'
        : '${joinNames(offline)} are unreachable';
  }

  /// "A", "A and B", "A, B and C".
  @visibleForTesting
  static String joinNames(List<String> names) {
    if (names.length < 2) return names.join();
    return '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  }

  @override
  Widget build(BuildContext context) {
    if (offlineServerNames.isEmpty && needsAuthServerNames.isEmpty) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final message = messageFor(
      offline: offlineServerNames,
      needsAuth: needsAuthServerNames,
    );

    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.screenPadding,
        8,
        AppSpacing.screenPadding,
        0,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: StatusColor.serverOffline.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppShape.medium),
        border: Border(
          left: BorderSide(color: StatusColor.serverOffline, width: 4),
        ),
      ),
      child: Row(
        children: [
          const Text('⚠', style: TextStyle(fontSize: 14)),
          const SizedBox(width: 8),
          Expanded(child: Text(message, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}
