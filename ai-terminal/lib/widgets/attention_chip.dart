/// `AttentionChip` — spec §2: a `SuggestionChip` with custom colors.
/// `approval` → "Needs approval" (Waiting container, priority icon);
/// `apierror` → "API error" (error container, warning icon);
/// `idle` → "Done" (Idle container, check icon).
library;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/status_colors.dart';

class AttentionChip extends StatelessWidget {
  const AttentionChip({
    super.key,
    required this.kind,
    this.onTap,
    this.onDismiss,
  });

  /// One of `approval` | `apierror` | `idle`.
  final String kind;

  /// Tapping the chip body — opens the attention detail sheet.
  final VoidCallback? onTap;

  /// Tapping the trailing `×` — dismisses the attention marker locally
  /// (spec §3 "Dismiss notification": no server call in Phase 1).
  final VoidCallback? onDismiss;

  (Color, IconData, String) _spec() {
    switch (kind) {
      case 'approval':
        return (StatusColor.waiting, Icons.priority_high, 'Needs approval');
      case 'apierror':
        return (StatusColor.apiError, Icons.warning_amber_rounded, 'API error');
      case 'idle':
        return (StatusColor.idle, Icons.check_circle, 'Done');
      default:
        return (StatusColor.idle, Icons.info_outline, kind);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (color, icon, label) = _spec();
    return Material(
      color: color.withValues(alpha: 0.15),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppShape.small),
        side: BorderSide(color: color.withValues(alpha: 0.4)),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppShape.small),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 4),
              Text(
                label,
                style: theme.textTheme.labelSmall?.copyWith(color: color),
              ),
              if (onDismiss != null) ...[
                const SizedBox(width: 4),
                InkWell(
                  onTap: onDismiss,
                  child: Icon(
                    Icons.close,
                    size: 14,
                    color: color.withValues(alpha: 0.8),
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
