// #571 - a Mission Control card opened to its FULL context: tap a card and read what is needed to
// answer it, in the session's own words.
//
// The card's line is a headline; the owner could not answer "your answer on #22946, your OK on four
// pushback drafts and a yes or no on closing #20606" from it ("open a modal dialog for each card I
// click with the context so the question will be understandable"). The sheet shows, top to bottom:
//   1. what it asks - the question or decision with its context and EACH option with its
//      consequence (the recommended one starred), a question card's questions, a wait's words, an
//      action's steps;
//   2. every work item the session names, with its ADO station (or stage) and state, each tappable
//      to the item's page;
//   3. the session's last reply IN FULL, markdown rendered (links are text spans, #83) - its own
//      words, not the TL;DR the card shows and not a model's account of them (that stays the
//      card's "More context").
// Answer and Open session are here too, through the SAME paths as on the card ([McCardContextPort]
// is the home's `_answer` and `openSession`): the sheet sends nothing and decides nothing.
//
// A phone (narrower than [AdaptiveHome.splitBreakpoint]) gets it full screen, a desktop a dialog.
// Every section degrades to a line saying why it is empty; none can fail the sheet.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/mc_models.dart';
import '../../services/mc_card_context.dart';
import '../../theme/app_theme.dart';
import '../../widgets/question_answer_panel.dart' show leadUpMarkdown;
import '../adaptive_home.dart' show AdaptiveHome;
import 'card_decision.dart';
import 'now_view.dart' show McTag, mcAge, mcCardAge;

/// What the sheet reads and may do, every one a callback so Mission Control's home gives it the
/// real readers and the real answer paths, and a test gives it fakes.
class McCardContextPort {
  const McCardContextPort({
    required this.reply,
    required this.items,
    required this.openSubject,
    required this.answer,
    required this.openSession,
  });

  /// The card's session's last reply ([McCardContextReader.reply]); never throws.
  final Future<McContextReply> Function(McCard card) reply;

  /// The work items the card's session names ([McCardContextReader.items]); never throws.
  final Future<List<McContextItem>> Function(McCard card) items;

  /// Opens a work item's page (a subject's key).
  final void Function(String key) openSubject;

  /// The card's answer path: the home's `_answer` (the reply dialog for an ask, the answer sheet
  /// for a wait, a decision or a question).
  final void Function(McCard card) answer;

  /// Opens the card's session.
  final void Function(McCard card) openSession;
}

class McCardContextSheet extends StatefulWidget {
  const McCardContextSheet({super.key, required this.card, required this.port, this.now});

  final McCard card;
  final McCardContextPort port;

  /// Injectable for tests: the clock ages are read against.
  final DateTime? now;

  /// Opens the sheet: full screen on a phone, a dialog on a desktop.
  static Future<void> open(BuildContext context, {required McCard card, required McCardContextPort port, DateTime? now}) {
    final size = MediaQuery.sizeOf(context);
    if (size.width >= AdaptiveHome.splitBreakpoint) {
      return showDialog<void>(
        context: context,
        builder: (_) => Dialog(
          clipBehavior: Clip.antiAlias,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: 760, maxHeight: size.height * 0.88),
            child: McCardContextSheet(card: card, port: port, now: now),
          ),
        ),
      );
    }
    return Navigator.of(context).push(
      MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => McCardContextSheet(card: card, port: port, now: now)),
    );
  }

  @override
  State<McCardContextSheet> createState() => _McCardContextSheetState();
}

class _McCardContextSheetState extends State<McCardContextSheet> {
  late final Future<McContextReply> _reply = _safe(
      () => widget.port.reply(widget.card), const McContextReply(problem: 'Its reply could not be read.'));
  late final Future<List<McContextItem>> _items = _safe(() => widget.port.items(widget.card), const <McContextItem>[]);

  /// A reader that throws is an empty section, never a sheet that does not open.
  static Future<T> _safe<T>(Future<T> Function() read, T fallback) async {
    try {
      return await read();
    } catch (_) {
      return fallback;
    }
  }

  McCard get _card => widget.card;

  /// Closes the sheet, then runs [then]: the answer and the session open over what was under it.
  void _leaveTo(VoidCallback then) {
    Navigator.of(context).pop();
    then();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final c = _card;
    final heading = [?c.ref, ?c.title].join('  ');
    final session = [?c.sessionName, ?c.server].join(' · ');
    final age = mcCardAge(c, now: widget.now);
    final title = heading.isNotEmpty ? heading : (c.sessionName ?? 'A session');
    return Scaffold(
      key: const ValueKey('mc-ctx-sheet'),
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: Text(title, key: const ValueKey('mc-ctx-title'), maxLines: 2, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            key: const ValueKey('mc-ctx-close'),
            tooltip: 'Close',
            icon: const Icon(Icons.close),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
      body: SelectionArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
          Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (c.project != null) McTag(c.project!),
            McTag(c.isPossibleAsk ? 'possible unreported question' : c.kind, muted: true),
            if (c.maybeAnswered) McTag('may be answered', muted: true),
            if (c.why.severity != null) McTag('severity ${c.why.severity}', color: AppColors.caution),
            if (age != null) Text(age, style: muted),
          ]),
          if (session.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(session, style: muted)),
          const SizedBox(height: 12),
          _Section(title: _askTitle(c), child: _asking(context)),
          _Section(title: 'Work items it names', child: _itemsBody(context)),
          _Section(title: 'Its last reply', child: _replyBody(context)),
        ]),
      ),
      bottomNavigationBar: _actions(context),
    );
  }

  static String _askTitle(McCard c) {
    if (c.isAction) return 'What it needs you to do';
    if (c.decision != null) return 'The decision';
    if (c.kind == 'question') return c.questions.length > 1 ? 'The questions' : 'The question';
    return 'What it asks';
  }

  // --- 1. what it asks ------------------------------------------------------------------

  Widget _asking(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final c = _card;
    final d = c.decision;
    final steps = c.action?.steps ?? const <String>[];
    // A decision's own line is its question: say it once, the way the card's face does.
    final what = c.what != null && !(d != null && mcSameQuestion(c.what!, d.question)) && c.kind != 'question' ? c.what : null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (d != null)
        Text(d.question, key: const ValueKey('mc-ctx-question'), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      if (what != null) Text(what, key: const ValueKey('mc-ctx-what'), style: d == null ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium),
      if (c.kind == 'question')
        c.questions.isEmpty
            ? Text('A question is on its screen; its text could not be read here. Answer opens it.',
                key: const ValueKey('mc-ctx-q-unread'), style: muted)
            : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (var i = 0; i < c.questions.length; i++)
                  Padding(
                    key: ValueKey('mc-ctx-q-$i'),
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      if (c.questions[i].header != null)
                        Text(c.questions[i].header!,
                            style: theme.textTheme.labelMedium?.copyWith(color: AppColors.primary, fontWeight: FontWeight.w600)),
                      Text(c.questions[i].text, style: theme.textTheme.titleSmall),
                    ]),
                  ),
              ]),
      if (d != null)
        // The card's own detail, read-only here: the context, every option with its consequence,
        // the recommended one starred. Answering is the sheet's Answer, on the card's own path.
        McCardDetail(decision: d, controller: null, onPick: null, onSend: null),
      if (steps.isNotEmpty) ...[
        const SizedBox(height: 6),
        for (var i = 0; i < steps.length; i++)
          Padding(
            key: ValueKey('mc-ctx-step-$i'),
            padding: const EdgeInsets.only(bottom: 2),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 22, child: Text('${i + 1}.', style: muted)),
              Expanded(child: Text(steps[i], style: theme.textTheme.bodyMedium)),
            ]),
          ),
        if (c.action?.where != null) Text('Where: ${c.action!.where}', style: muted),
      ],
      if (c.isPossibleAsk)
        Text("Its last reply may ask you something it did not report; the reply is below.", style: muted),
      if (c.why.text != null) ...[
        const SizedBox(height: 6),
        Text(c.why.text!, key: const ValueKey('mc-ctx-why'), style: muted?.copyWith(color: c.blocking ? AppColors.caution : AppColors.onSurfaceVariant)),
      ],
    ]);
  }

  // --- 2. the work items ----------------------------------------------------------------

  Widget _itemsBody(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return FutureBuilder<List<McContextItem>>(
      future: _items,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const LinearProgressIndicator(key: ValueKey('mc-ctx-items-loading'));
        }
        final items = snap.data ?? const <McContextItem>[];
        if (items.isEmpty) {
          return Text('It names no work item.', key: const ValueKey('mc-ctx-items-none'), style: muted);
        }
        return Column(key: const ValueKey('mc-ctx-items'), crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < items.length; i++) _itemRow(context, items[i], i),
        ]);
      },
    );
  }

  Widget _itemRow(BuildContext context, McContextItem it, int i) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final where = it.where;
    return InkWell(
      key: ValueKey('mc-ctx-item-$i'),
      borderRadius: BorderRadius.circular(6),
      onTap: it.key == null ? null : () => _leaveTo(() => widget.port.openSubject(it.key!)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text([it.ref, ?it.title].join('  '), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
              if (where != null || it.state != null)
                Wrap(spacing: 10, children: [
                  if (where != null)
                    Text(where, key: ValueKey('mc-ctx-item-where-$i'), style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                  if (it.state != null) Text('reported: ${it.state}', key: ValueKey('mc-ctx-item-state-$i'), style: muted),
                ]),
              if (it.note != null) Text(it.note!, style: muted),
            ]),
          ),
          const Icon(Icons.chevron_right, size: 20, color: AppColors.onSurfaceVariant),
        ]),
      ),
    );
  }

  // --- 3. its last reply ----------------------------------------------------------------

  Widget _replyBody(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return FutureBuilder<McContextReply>(
      future: _reply,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const LinearProgressIndicator(key: ValueKey('mc-ctx-reply-loading'));
        }
        final r = snap.data ?? const McContextReply();
        final text = r.text;
        if (text == null || text.trim().isEmpty) {
          return Text(r.problem ?? 'It has not written a reply yet.',
              key: ValueKey(r.problem == null ? 'mc-ctx-reply-none' : 'mc-ctx-reply-problem'),
              style: r.problem == null ? muted : TextStyle(color: theme.colorScheme.error));
        }
        final at = r.at;
        final ago = at == null ? null : mcAge((widget.now ?? DateTime.now()).difference(at).abs());
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (ago != null)
            Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(ago == 'just now' ? 'Written just now' : 'Written $ago ago', key: const ValueKey('mc-ctx-reply-age'), style: muted)),
          if (!r.whole)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text('Only the short form of the reply: this server cannot send the whole text yet.',
                  key: const ValueKey('mc-ctx-reply-short'), style: muted),
            ),
          KeyedSubtree(key: const ValueKey('mc-ctx-reply'), child: leadUpMarkdown(theme, text)),
        ]);
      },
    );
  }

  // --- Answer / Open session ------------------------------------------------------------

  Widget? _actions(BuildContext context) {
    final c = _card;
    // An action is DONE from its card, never answered; everything else a session waits on is.
    final canAnswer = c.answerable && !c.isAction;
    final canOpen = c.sessionId != null;
    if (!canAnswer && !canOpen) return null;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Wrap(spacing: 8, runSpacing: 4, alignment: WrapAlignment.end, children: [
          if (canOpen)
            OutlinedButton.icon(
              key: const ValueKey('mc-ctx-open'),
              onPressed: () => _leaveTo(() => widget.port.openSession(c)),
              icon: const Icon(Icons.open_in_new, size: 18),
              label: const Text('Open session'),
            ),
          if (canAnswer)
            FilledButton.icon(
              key: const ValueKey('mc-ctx-answer'),
              onPressed: () => _leaveTo(() => widget.port.answer(c)),
              icon: const Icon(Icons.reply, size: 18),
              label: const Text('Answer'),
            ),
        ]),
      ),
    );
  }
}

/// A titled block of the sheet.
class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title.toUpperCase(), style: theme.textTheme.labelSmall?.copyWith(color: AppColors.primary, letterSpacing: 0.8, fontWeight: FontWeight.w700)),
        const Divider(height: 10),
        child,
      ]),
    );
  }
}
