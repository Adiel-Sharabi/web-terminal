/// `ServerBadge` — spec §2: a primaryContainer pill, 4dp radius, labelSmall,
/// name truncated to 12 chars.
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class ServerBadge extends StatelessWidget {
  const ServerBadge({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final truncated = name.length > 12 ? '${name.substring(0, 12)}…' : name;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: theme.colorScheme.primaryContainer,
        borderRadius: BorderRadius.circular(AppShape.small),
      ),
      child: Text(
        truncated,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onPrimaryContainer,
        ),
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}
