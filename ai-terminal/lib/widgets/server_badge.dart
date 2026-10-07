/// `ServerBadge` — spec §2: a primaryContainer pill, 4dp radius, labelSmall,
/// name truncated to 12 chars.
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class ServerBadge extends StatelessWidget {
  const ServerBadge({super.key, required this.name, this.color});

  final String name;

  /// The machine's own colour (#315), declared by its server. Null keeps the
  /// original look, for a server that has not said.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final truncated = name.length > 12 ? '${name.substring(0, 12)}…' : name;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        // A tint of the machine's colour, never a solid fill: solid would read as
        // a status, and a machine must never look like one.
        color: color?.withValues(alpha: 0.14) ?? theme.colorScheme.primaryContainer,
        borderRadius: BorderRadius.circular(AppShape.small),
      ),
      child: Text(
        truncated,
        style: theme.textTheme.labelSmall?.copyWith(
          color: color ?? theme.colorScheme.onPrimaryContainer,
        ),
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// A machine is a SQUARE (#315); a status is a circle. Shown before a server's name
/// in group headers and filter chips.
class ServerSwatch extends StatelessWidget {
  const ServerSwatch({super.key, required this.color, this.size = 8});

  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (color == null) return const SizedBox.shrink();
    return Container(
      width: size,
      height: size,
      margin: const EdgeInsets.only(right: 6),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
    );
  }
}
