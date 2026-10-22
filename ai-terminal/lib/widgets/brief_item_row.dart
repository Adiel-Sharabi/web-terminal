import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/models.dart';

/// `ready-for-test` -> `ready for test`.
String briefStateLabel(String state) => state.replaceAll('-', ' ');

/// The pill colours for a work-item state; matches `app.html`'s `.db-state.s-*`.
({Color bg, Color fg}) briefStateColors(String? state) => switch (state) {
      'planning' => (bg: const Color(0xFF2A2540), fg: const Color(0xFFC9BCFF)),
      'in-progress' => (bg: const Color(0xFF3A2A12), fg: const Color(0xFFFFB454)),
      'blocked' => (bg: const Color(0xFF3A1D26), fg: const Color(0xFFFF9AAC)),
      'ready-for-test' => (bg: const Color(0xFF123A33), fg: const Color(0xFF5FE8C9)),
      'committed' => (bg: const Color(0xFF1B2B3D), fg: const Color(0xFF9CC6F0)),
      'done' => (bg: const Color(0xFF1D3320), fg: const Color(0xFF8FD59A)),
      _ => (bg: const Color(0xFF2A303C), fg: const Color(0xFFC3C9D4)),
    };

/// One work item of a session's brief (#306): its ref (a link when it has one), its
/// title, its state pill, and an unpin button for a pinned item when [onUnpin] is set.
class BriefItemRow extends StatelessWidget {
  const BriefItemRow(this.item, {super.key, this.onUnpin});
  final BriefItem item;
  final void Function(BriefItem item)? onUnpin;

  @override
  Widget build(BuildContext context) {
    final it = item;
    final theme = Theme.of(context);
    final ref = Text(it.ref,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: theme.colorScheme.primary,
          fontFamily: 'monospace',
          fontFamilyFallback: const ['Consolas', 'Menlo', 'Courier New'],
          fontSize: 12,
          decoration: it.url != null ? TextDecoration.underline : null,
        ));
    final uri = it.url == null ? null : Uri.tryParse(it.url!);
    return Tooltip(
      message: it.note,
      child: Row(children: [
        // Flexible: a qualified ref (`owner/repo#306`) beside a state pill and an
        // unpin button is wider than a phone card. The ref gives way, not the pill.
        Flexible(
          child: uri != null
              ? InkWell(
                  onTap: () => launchUrl(uri, mode: LaunchMode.externalApplication),
                  child: ref,
                )
              : ref,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(it.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
        ),
        if (it.state != null) ...[const SizedBox(width: 6), _StatePill(it.state!)],
        if (it.pinned && onUnpin != null)
          IconButton(
            tooltip: 'Unpin ${it.ref}',
            visualDensity: VisualDensity.compact,
            iconSize: 16,
            icon: const Icon(Icons.close),
            onPressed: () => onUnpin!(it),
          ),
      ]),
    );
  }
}

class _StatePill extends StatelessWidget {
  const _StatePill(this.state);
  final String state;

  @override
  Widget build(BuildContext context) {
    final c = briefStateColors(state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(color: c.bg, borderRadius: BorderRadius.circular(999)),
      child: Text(briefStateLabel(state),
          style: TextStyle(color: c.fg, fontSize: 10, fontWeight: FontWeight.w600)),
    );
  }
}
