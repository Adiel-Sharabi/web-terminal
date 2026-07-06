/// Partial-offline banner — spec §2:
/// "⚠ {Server} is unreachable — sessions from this server may be stale"
/// (or "N servers are unreachable" for multiple), `ServerOffline` 12% bg +
/// 4dp left border.
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, required this.offlineServerNames});

  final List<String> offlineServerNames;

  @override
  Widget build(BuildContext context) {
    if (offlineServerNames.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final message = offlineServerNames.length == 1
        ? '${offlineServerNames.first} is unreachable — sessions from this server may be stale'
        : '${offlineServerNames.length} servers are unreachable';

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
