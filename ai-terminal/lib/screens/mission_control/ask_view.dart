// #511 - Mission Control's Ask: a question box, the answers, and their sources.
//
// The Ask tab on a phone and the Ask panel on desktop are this view over the home's one
// [McAskThread], so a conversation survives switching tabs or closing the panel. A later
// screen embeds it with a fixed scope (#509's "Ask about this subject").
//
// The answer is the server's plain text, shown as text (never markdown or HTML: it was
// written from session text that may hold anything). Each source is a chip: a session,
// its report or recap opens the session; a work item or PR opens its link. Under each
// answer: how old the data was, and what did not fit.

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/mc_ask_models.dart';
import '../../api/mc_models.dart';
import '../../services/mc_analyst.dart';
import '../../widgets/format_utils.dart' show relativeTime;

class McAskView extends StatefulWidget {
  const McAskView({
    super.key,
    required this.thread,
    required this.onOpenSession,
    this.projects = const [],
    this.fixedScope,
    this.fixedScopeLabel,
    this.onOpenUrl,
  });

  final McAskThread thread;

  /// Opens a session by id (a session, report or recap source).
  final void Function(String sessionId) onOpenSession;

  /// The projects offered as scopes beside "Everything" (ignored with [fixedScope]).
  final List<McProject> projects;

  /// Every question is about this scope, and no scope picker is shown.
  final McAskScope? fixedScope;
  final String? fixedScopeLabel;

  /// Opens a work item or PR link; defaults to the system browser.
  final void Function(Uri url)? onOpenUrl;

  @override
  State<McAskView> createState() => _McAskViewState();
}

class _McAskViewState extends State<McAskView> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  McAskScope _scope = McAskScope.all;

  McAskScope get _effectiveScope => widget.fixedScope ?? _scope;

  String _labelOf(McAskScope s) {
    if (widget.fixedScope != null) return widget.fixedScopeLabel ?? s.id ?? 'this';
    if (s.kind == 'all') return 'Everything';
    for (final p in widget.projects) {
      if (p.id == s.id) return p.name;
    }
    return s.id ?? s.kind;
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final q = _input.text.trim();
    if (q.isEmpty || widget.thread.busy) return;
    _input.clear();
    final scope = _effectiveScope;
    final f = widget.thread.ask(q, scope, scopeLabel: _labelOf(scope));
    _toEnd();
    await f;
    _toEnd();
  }

  void _toEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  void _openSource(McSource s) {
    final sid = s.sessionId;
    if (s.opensSession && sid != null) {
      widget.onOpenSession(sid);
      return;
    }
    final uri = s.url == null ? null : Uri.tryParse(s.url!);
    if (uri == null || !(uri.scheme == 'https' || uri.scheme == 'http')) return;
    (widget.onOpenUrl ?? (u) => launchUrl(u, mode: LaunchMode.externalApplication))(uri);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.thread,
      builder: (context, _) {
        final items = widget.thread.items;
        return Column(
          key: const ValueKey('mc-ask-view'),
          children: [
            Expanded(
              child: items.isEmpty
                  ? const _AskIntro()
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                      itemCount: items.length,
                      itemBuilder: (context, i) => _ExchangeCard(exchange: items[i], onSource: _openSource),
                    ),
            ),
            const Divider(height: 1),
            if (widget.fixedScope == null) _scopePicker(context),
            _inputRow(context),
          ],
        );
      },
    );
  }

  Widget _scopePicker(BuildContext context) {
    final scopes = [McAskScope.all, for (final p in widget.projects) McAskScope.project(p.id)];
    return SizedBox(
      height: 44,
      child: ListView(
        key: const ValueKey('mc-ask-scopes'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
        children: [
          for (final s in scopes)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                key: ValueKey('mc-ask-scope-${s.kind}-${s.id ?? ''}'),
                label: Text(_labelOf(s)),
                selected: _scope == s,
                onSelected: (_) => setState(() => _scope = s),
                visualDensity: VisualDensity.compact,
              ),
            ),
        ],
      ),
    );
  }

  Widget _inputRow(BuildContext context) {
    final busy = widget.thread.busy;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: TextField(
            key: const ValueKey('mc-ask-input'),
            controller: _input,
            minLines: 1,
            maxLines: 4,
            maxLength: 2000,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _send(),
            decoration: InputDecoration(
              hintText: 'Ask about ${_labelOf(_effectiveScope)}',
              counterText: '',
              isDense: true,
              border: const OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(width: 4),
        IconButton(
          key: const ValueKey('mc-ask-send'),
          tooltip: busy ? 'Waiting for the answer' : 'Ask',
          icon: const Icon(Icons.send),
          onPressed: busy ? null : _send,
        ),
      ]),
    );
  }
}

class _AskIntro extends StatelessWidget {
  const _AskIntro();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'Ask about your sessions and work items: what is stuck, what changed today, where a piece of work stands.\n\n'
          'The Analyst reads what the sessions reported, recent recaps and the cached tracker details, '
          'and says how old they are. It cannot change anything or type into a session.',
          key: const ValueKey('mc-ask-intro'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ),
    );
  }
}

class _ExchangeCard extends StatelessWidget {
  const _ExchangeCard({required this.exchange, required this.onSource});

  final McAskExchange exchange;
  final void Function(McSource) onSource;

  static IconData _icon(String kind) => switch (kind) {
        'session' => Icons.terminal,
        'report' => Icons.assignment_outlined,
        'recap' => Icons.history,
        'pr' => Icons.merge_type,
        _ => Icons.label_outline,
      };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final a = exchange.answer;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(exchange.question, style: t.textTheme.titleSmall),
          Text('About: ${exchange.scopeLabel}', style: t.textTheme.bodySmall),
          const SizedBox(height: 8),
          if (exchange.pending) ...[
            const LinearProgressIndicator(key: ValueKey('mc-ask-pending')),
            const SizedBox(height: 6),
            Text('The Analyst is reading... this can take a minute.', style: t.textTheme.bodySmall),
          ],
          if (exchange.error != null)
            Text(exchange.error!, key: const ValueKey('mc-ask-error'), style: TextStyle(color: t.colorScheme.error)),
          if (a != null) ...[
            SelectableText(a.answer, key: const ValueKey('mc-ask-answer')),
            const SizedBox(height: 8),
            Text(_ageLine(a), key: const ValueKey('mc-ask-age'), style: t.textTheme.bodySmall),
            if (a.cut != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(a.cut!.text, key: const ValueKey('mc-ask-cut'), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.tertiary)),
              ),
            if (a.sources.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final s in a.sources)
                  ActionChip(
                    key: ValueKey('mc-ask-source-${s.id}'),
                    avatar: Icon(_icon(s.kind), size: 16),
                    label: Text('${s.id} ${s.label}${s.at != null ? ' · ${relativeTime(s.at!.millisecondsSinceEpoch)}' : ''}',
                        overflow: TextOverflow.ellipsis),
                    tooltip: s.opensSession ? 'Open the session' : (s.url ?? s.label),
                    onPressed: (s.opensSession || s.url != null) ? () => onSource(s) : null,
                    visualDensity: VisualDensity.compact,
                  ),
              ]),
            ],
          ],
        ]),
      ),
    );
  }

  static String _ageLine(McAnswer a) {
    final who = a.model == null ? 'Answered by the server' : 'Answered by ${a.model}';
    final o = a.oldestAt;
    final n = a.newestAt;
    if (o == null && n == null) return '$who · the data has no time on it';
    if (o == null || n == null || o == n) return '$who · data from ${relativeTime((o ?? n)!.millisecondsSinceEpoch)}';
    return '$who · data from ${relativeTime(o.millisecondsSinceEpoch)} to ${relativeTime(n.millisecondsSinceEpoch)}';
  }
}
