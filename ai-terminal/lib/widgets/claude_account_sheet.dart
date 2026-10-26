import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../theme/app_theme.dart';
import 'app_bottom_sheet.dart';
import 'format_utils.dart' show kWarnAmber;

/// "Switch account" for ONE machine (#389): which Claude account the machine is
/// logged in to, the accounts saved on it, and a switch between them.
///
/// Per machine on purpose. Each machine keeps its own saved copy of each account
/// (refresh tokens rotate, so a login copied between machines logs both out), and the
/// owner switches machines one at a time. The machine's running sessions follow the
/// switch with no restart; the server does the swap and the save-before-switch
/// (`lib/claude-account.js`). This sheet only paints and asks.
Future<void> showClaudeAccountSheet(
  BuildContext context, {
  required ApiClient client,
  required String machineName,
}) {
  return showAppBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => ClaudeAccountSheet(client: client, machineName: machineName),
  );
}

class ClaudeAccountSheet extends StatefulWidget {
  const ClaudeAccountSheet({super.key, required this.client, required this.machineName});

  final ApiClient client;
  final String machineName;

  @override
  State<ClaudeAccountSheet> createState() => _ClaudeAccountSheetState();
}

class _ClaudeAccountSheetState extends State<ClaudeAccountSheet> {
  ClaudeAccountStatus? _status;
  String? _error;

  /// The write in flight, so a second tap cannot start a second one.
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await widget.client.claudeAccount();
      if (mounted) setState(() { _status = s; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _run(Future<ClaudeAccountStatus> Function() write, String done) async {
    setState(() => _busy = true);
    try {
      final s = await write();
      if (!mounted) return;
      setState(() { _status = s; _error = null; });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _switch(ClaudeAccount to) async {
    final name = to.email ?? to.label ?? '?';
    // Busy from the first tap, so a second tap cannot open a second dialog.
    setState(() => _busy = true);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Switch ${widget.machineName}?'),
        content: Text('Log ${widget.machineName} in to $name. Its running sessions '
            'move to that account too. The current login is saved first.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Switch')),
        ],
      ),
    );
    if (!mounted) return;
    if (ok != true) {
      setState(() => _busy = false);
      return;
    }
    await _run(() => widget.client.switchClaudeAccount(to.key!), '${widget.machineName} is now on $name');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final s = _status;
    final active = s?.active;
    final others = s == null ? const <ClaudeAccount>[] : s.saved.where((a) => !a.active).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.screenPadding, 0, AppSpacing.screenPadding, AppSpacing.screenPadding),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Claude account · ${widget.machineName}', style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(_error!, key: const ValueKey('claude-account-error'),
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
            ),
          if (s == null && _error == null)
            const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
          if (s != null) ...[
            Text('Logged in now', style: muted),
            if (active == null)
              const Text('Not logged in')
            else
              _AccountTile(account: active, current: true),
            if (active != null && active.label == null) ...[
              Text('Not saved on this machine yet: save it to switch back to it later.', style: muted),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  key: const ValueKey('claude-account-save'),
                  onPressed: _busy ? null : () => _run(widget.client.saveClaudeAccount, 'Saved ${active.email ?? ''}'),
                  icon: const Icon(Icons.save_outlined),
                  label: const Text('Save this login'),
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(others.isEmpty ? 'No other account saved on this machine' : 'Switch to', style: muted),
            for (final a in others)
              _AccountTile(account: a, onTap: _busy || a.broken || a.key == null ? null : () => _switch(a)),
            const SizedBox(height: 8),
            Text('To add an account: run /login in a Claude session on this machine, '
                'then open this sheet again and save it.', style: muted),
          ],
        ],
      ),
    );
  }
}

class _AccountTile extends StatelessWidget {
  const _AccountTile({required this.account, this.current = false, this.onTap});

  final ClaudeAccount account;
  final bool current;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final exp = account.refreshExpiresAt;
    final parts = [
      if (account.plan != null) account.plan!,
      if (exp != null) 'login valid until ${exp.year}-${_two(exp.month)}-${_two(exp.day)}',
    ];
    return ListTile(
      key: ValueKey('claude-account-${account.key}'),
      contentPadding: EdgeInsets.zero,
      leading: Icon(current ? Icons.check_circle : Icons.account_circle_outlined,
          color: current ? theme.colorScheme.primary : null),
      title: Text(account.broken ? '${account.label} (unreadable)' : account.email ?? account.label ?? '?'),
      subtitle: parts.isEmpty && !account.refreshExpiringSoon
          ? null
          : Text(
              [...parts, if (account.refreshExpiringSoon) 'expires soon: /login to it again'].join(' · '),
              style: account.refreshExpiringSoon ? TextStyle(color: kWarnAmber) : null,
            ),
      trailing: onTap == null ? null : const Icon(Icons.swap_horiz),
      onTap: onTap,
    );
  }

  static String _two(int n) => n.toString().padLeft(2, '0');
}
