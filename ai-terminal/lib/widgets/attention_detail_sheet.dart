/// Attention detail sheet — spec §3, adapted for this app's pivot away from
/// voice (no read-aloud button/switch) and away from a web UI (`Open in web`
/// becomes `Open in terminal`, navigating into the native [SessionScreen]
/// instead of a Custom Tab). Opened from the [AttentionChip] on a session
/// card, not from tapping the card itself (the card tap goes straight to the
/// terminal per the owner's pivot).
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import 'format_utils.dart';
import 'server_badge.dart';

const int _kMaxMessageChars = 2000;

/// Opens the sheet for [session]. [onOpenTerminal] is called (and the sheet
/// closed) when the user taps "Open in terminal" — the caller owns navigation
/// so this widgets-layer file has no dependency on the screens layer.
Future<void> showAttentionDetailSheet(
  BuildContext context,
  Session session, {
  required VoidCallback onOpenTerminal,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _AttentionDetailSheet(
      session: session,
      api: ApiClient(session.server),
      onOpenTerminal: onOpenTerminal,
    ),
  );
}

class _AttentionDetailSheet extends StatefulWidget {
  const _AttentionDetailSheet({
    required this.session,
    required this.api,
    required this.onOpenTerminal,
  });

  final Session session;
  final ApiClient api;
  final VoidCallback onOpenTerminal;

  @override
  State<_AttentionDetailSheet> createState() => _AttentionDetailSheetState();
}

class _AttentionDetailSheetState extends State<_AttentionDetailSheet> {
  bool _loading = true;
  String? _error;
  AttentionInfo? _info;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    // ApiClient already applies a 10s per-call timeout; spec §3 additionally
    // wants one retry after a 2s pause before surfacing the failure banner.
    try {
      final info = await widget.api.attention(widget.session.id);
      if (!mounted) return;
      setState(() {
        _info = info;
        _loading = false;
      });
    } catch (_) {
      await Future.delayed(const Duration(seconds: 2));
      if (!mounted) return;
      try {
        final info = await widget.api.attention(widget.session.id);
        if (!mounted) return;
        setState(() {
          _info = info;
          _loading = false;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  void _openTerminal() {
    Navigator.pop(context);
    widget.onOpenTerminal();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;
    final displayName = session.name.isEmpty
        ? 'Session ${session.shortId}'
        : session.name;

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.screenPadding,
          0,
          AppSpacing.screenPadding,
          AppSpacing.screenPadding,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                ServerBadge(name: session.server.name),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    displayName,
                    style: theme.textTheme.titleLarge,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            if (_info?.at != null) ...[
              const SizedBox(height: 4),
              Text(
                absoluteTime(_info!.at),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 16),
            if (_loading)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: CircularProgressIndicator(),
                ),
              ),
            if (!_loading && _error != null)
              _ErrorBanner(error: _error!, onRetry: _load),
            if (!_loading && _error == null && _info != null)
              ..._buildContent(theme),
            const SizedBox(height: 16),
            FilledButton.tonalIcon(
              onPressed: _openTerminal,
              icon: const Icon(Icons.terminal),
              label: const Text('Open in terminal'),
            ),
            const SizedBox(height: 4),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Dismiss notification'),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildContent(ThemeData theme) {
    final info = _info!;
    final kind = info.hasAttention ? info.kind : null;
    final widgets = <Widget>[];
    if (kind != null) {
      widgets.add(_KindBanner(kind: kind));
      widgets.add(const SizedBox(height: 16));
    } else {
      widgets.add(
        Text(
          'This has already been resolved.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );
      widgets.add(const SizedBox(height: 16));
    }
    if ((info.reason ?? '').isNotEmpty) {
      widgets.add(_SectionHeader('REASON'));
      widgets.add(Text(info.reason!, style: theme.textTheme.bodyMedium));
      widgets.add(const SizedBox(height: 16));
    }
    if ((info.lastMessage ?? '').isNotEmpty) {
      widgets.add(_SectionHeader('LAST MESSAGE'));
      var message = info.lastMessage!;
      if (message.length > _kMaxMessageChars) {
        message =
            '${message.substring(0, _kMaxMessageChars)}\n[Message truncated — open in terminal for full content]';
      }
      widgets.add(SelectableText(message, style: theme.textTheme.bodyMedium));
      widgets.add(const SizedBox(height: 16));
    }
    return widgets;
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          letterSpacing: 0.08,
        ),
      ),
    );
  }
}

class _KindBanner extends StatelessWidget {
  const _KindBanner({required this.kind});
  final String kind;

  (Color, IconData, String) _spec() {
    switch (kind) {
      case 'approval':
        return (StatusColor.waiting, Icons.priority_high, 'NEEDS APPROVAL');
      case 'apierror':
        return (StatusColor.apiError, Icons.warning_amber_rounded, 'API ERROR');
      case 'idle':
        return (StatusColor.idle, Icons.check_circle, 'DONE');
      default:
        return (StatusColor.idle, Icons.info_outline, kind.toUpperCase());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (color, icon, label) = _spec();
    final bg = kind == 'apierror'
        ? theme.colorScheme.errorContainer
        : color.withValues(alpha: 0.15);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 8),
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: color,
              letterSpacing: 0.08,
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error, required this.onRetry});
  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '⚠ Server unreachable — content couldn\'t be loaded. Make sure you\'re on the Tailscale network.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
