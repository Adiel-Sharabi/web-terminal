// The writers behind a "needs you" card (#337, extracted for #383): answer a question,
// reply to a session that said it is waiting, send a lone Esc. The sessions board owns
// one of these, and the questions inbox will own another, so the two can never come to
// write different bytes for the same card.
//
// None of it decides WHAT to write. A question's keys come from [buildAnswerFrames]
// (the caller builds them), a reply is [buildComposeSubmission], Esc is a lone `0x1b`;
// all of them travel through [SessionInputRunner], the session's own `/ws/:id` socket.
// This holds the state around those writes: one write per session at a time, the
// answered-and-landing questions, the replies awaiting #179's verdict, and the cached
// live questions behind the cards.

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../screens/session_screen.dart'
    show
        SubmitUnconfirmedOutcome,
        buildComposeSubmission,
        kSubmitPendingGrace,
        questionSignature,
        resolveSubmitUnconfirmedReaction,
        verifyAnswerLanded;
import '../widgets/question_overlay.dart' show AnswerFrame, answerNeedsConfirm, deliverAnswerFrames;
import 'question_draft_store.dart';
import 'session_input.dart';
import 'session_repository.dart';

/// What the re-check just before an answer's first key says (#383).
enum PreWriteVerdict {
  /// The question shown is still the one being asked: write.
  proceed,

  /// Nothing is being asked any more: it was answered somewhere else.
  gone,

  /// A different question is being asked now: the answer was for the old one.
  changed,

  /// The check itself failed, so whether it is still asked is unknown.
  refused,
}

/// The pre-write re-check (#383). An answer is keys typed into a TUI selector, so one
/// typed after the question was answered elsewhere, or replaced, lands in a selector
/// that is not there: the digits go to the prompt line or answer a question nobody
/// read. So the question is read again just before the first key and compared, by
/// CONTENT ([questionSignature]: the id flips between a hook id and a transcript id
/// for the same question), with the one on screen ([shownSig]).
///
/// [fresh] is what that read returned (null: nothing pending). [pollFailed] means the
/// read did not answer at all, and that refuses: a stalled link is no evidence that the
/// question is still there, and nothing is ever written on no evidence.
PreWriteVerdict preWriteVerdict(String shownSig, PendingQuestion? fresh, bool pollFailed) {
  if (pollFailed) return PreWriteVerdict.refused;
  if (fresh == null) return PreWriteVerdict.gone;
  return questionSignature(fresh) == shownSig ? PreWriteVerdict.proceed : PreWriteVerdict.changed;
}

/// The board's (and the inbox's) writers and their state. [say] reports a refusal or a
/// failure to the person; the owner gives it a snackbar.
class NeedsYouActions extends ChangeNotifier {
  NeedsYouActions({
    required this.repository,
    required this.client,
    required this.input,
    required this.say,
    this.questionEvery = const Duration(seconds: 4),
  });

  final SessionRepository repository;
  final ApiClient Function(ServerConfig server) client;
  final SessionInputRunner input;
  final void Function(String text) say;

  /// How long a session's live question is trusted before it is asked again.
  final Duration questionEvery;

  // #337 - the live question behind each question card, by [keyOf]: asked only for a
  // session that is waiting on one. null = asked, nothing pending.
  final Map<String, PendingQuestion?> _questions = {};
  final Map<String, DateTime> _questionAt = {};

  /// Sessions with a write in flight, so a second press cannot double-answer.
  final Set<String> _busy = {};

  /// The signature of a question answered from here, by [keyOf]: its buttons stay
  /// down until the server stops reporting it, so it cannot be answered twice.
  final Map<String, String> _answered = {};

  // #337 review - a reply is the person's words, so it follows the session screen's
  // rule (#179): kept until delivered, and put back if the agent never took it.
  /// Each reply box's text, by [keyOf]: owned here so a reply can be put back into it.
  final Map<String, TextEditingController> _replyBoxes = {};

  /// The last reply sent from here per session, and when, for a #179 restore.
  final Map<String, ({String text, int at})> _pendingReply = {};

  /// The `submitUnconfirmed` stamp already reacted to, per session.
  final Map<String, int?> _handledUnconfirmed = {};

  bool _disposed = false;

  /// One session, across servers: two servers can each have an `s1`.
  static String keyOf(Session s) => '${s.server.baseUrl}|${s.id}';

  /// The live question behind [s]'s card, once it has been read.
  PendingQuestion? questionFor(Session s) => _questions[keyOf(s)];

  /// A write to [s] is in flight.
  bool isBusy(Session s) => _busy.contains(keyOf(s));

  /// [q] was just answered from here and is still landing.
  bool isAnswering(Session s, PendingQuestion q) => _answered[keyOf(s)] == questionSignature(q);

  /// The reply box of [s], created empty on first use.
  TextEditingController replyBox(Session s) => _replyBoxes.putIfAbsent(keyOf(s), TextEditingController.new);

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// #337 - the question behind each question card of [waiting], from the same route
  /// the session screen's overlay reads (`GET /api/sessions/:id/pending-question`).
  /// Only [waiting] is asked; anything else's cache is dropped. Each session is asked
  /// at most once per [questionEvery].
  Future<void> refreshQuestions(Iterable<Session> waiting) async {
    final list = waiting.toList();
    final live = {for (final s in list) keyOf(s)};
    _questions.removeWhere((k, _) => !live.contains(k));
    _questionAt.removeWhere((k, _) => !live.contains(k));
    _answered.removeWhere((k, _) => !live.contains(k));
    final now = DateTime.now();
    final due = list.where((s) {
      final at = _questionAt[keyOf(s)];
      return at == null || now.difference(at) > questionEvery;
    }).toList();
    if (due.isEmpty) return;
    for (final s in due) {
      _questionAt[keyOf(s)] = now;
    }
    await Future.wait(due.map((s) async {
      try {
        _questions[keyOf(s)] = await client(s.server).pendingQuestion(s.id);
      } catch (_) {/* keep what is shown; the card still offers Open */}
    }));
    _changed();
  }

  /// Runs one write against [s], one at a time per session. False when the session
  /// could not be reached, which is said out loud: nothing was sent.
  Future<bool> write(Session s, Future<void> Function(void Function(String keys) send) body) async {
    final k = keyOf(s);
    if (_busy.contains(k)) return false;
    _busy.add(k);
    _changed();
    final ok = await input(s, body);
    _busy.remove(k);
    _changed();
    if (!ok) say('Could not reach "${s.name}" - nothing was sent');
    return ok;
  }

  /// Answers [shown], the question on [s]'s card, with [frames] (built by
  /// [buildAnswerFrames]), through the overlay's own pacing and confirm (#19).
  ///
  /// The question is read again first ([preWriteVerdict]) and anything but
  /// [PreWriteVerdict.proceed] writes nothing. A question still up after every check
  /// is put back, with a word that it did not take. The session's drafts
  /// ([QuestionDraftStore]) follow the session screen's rules: flagged when an answer
  /// carrying words goes out, cleared only when a poll positively saw the question go.
  Future<PreWriteVerdict> answer(Session s, PendingQuestion shown, List<AnswerFrame> frames) async {
    final k = keyOf(s);
    final sig = questionSignature(shown);
    if (_busy.contains(k)) return PreWriteVerdict.refused;
    // Down from the press: the re-check takes a round trip, and a second press in it
    // must not start a second answer.
    _answered[k] = sig;
    _busy.add(k);
    _changed();
    PendingQuestion? fresh;
    var pollFailed = false;
    try {
      fresh = await client(s.server).pendingQuestion(s.id);
    } catch (_) {
      pollFailed = true;
    }
    _busy.remove(k);
    final verdict = preWriteVerdict(sig, fresh, pollFailed);
    if (verdict != PreWriteVerdict.proceed) {
      _answered.remove(k);
      if (!pollFailed) _questions[k] = fresh;
      _changed();
      say(switch (verdict) {
        PreWriteVerdict.gone => '"${s.name}" is no longer asking it - nothing was sent',
        PreWriteVerdict.changed => '"${s.name}" is asking something else now - nothing was sent',
        _ => 'Could not check "${s.name}" is still asking it, so nothing was sent',
      });
      return verdict;
    }
    final drafts = QuestionDraftStore.instance.of(s.server.baseUrl, s.id);
    // Flag BEFORE the keys go out (#383), as the session screen does.
    drafts.markSent(sig, frames);
    PendingQuestion? stuck;
    final ok = await write(s, (send) async {
      await deliverAnswerFrames(frames, send);
      final verdict = await verifyAnswerLanded(
        answeredKey: sig,
        resendEnter: answerNeedsConfirm(frames),
        poll: () => client(s.server).pendingQuestion(s.id),
        resend: () => send('\r'),
      );
      stuck = verdict.stillPending;
      if (verdict.seen.shouldClearDrafts(drafts.key)) drafts.clear();
    });
    if (_disposed) return verdict;
    if (!ok || stuck != null) {
      _answered.remove(k);
      _changed();
    }
    if (ok && stuck != null) say('The answer did not take - open "${s.name}" to answer it there');
    unawaited(repository.refresh());
    return verdict;
  }

  /// A reply to a session that said it is waiting on you: the compose bar's submit,
  /// one frame (#44). Refused while the agent is not at its composer (#147), as the
  /// compose bar refuses it.
  Future<bool> reply(Session s, String text) async {
    final val = text.replaceFirst(RegExp(r'[\r\n]+$'), '');
    if (val.trim().isEmpty) return false;
    if (!s.agentReady) {
      say('"${s.name}" is still starting - nothing was sent');
      return false;
    }
    final sentAt = DateTime.now().millisecondsSinceEpoch;
    final ok = await write(s, (send) async => send(buildComposeSubmission(val)));
    if (ok) {
      // Delivered to an ATTACHED session (see services/session_input.dart). Whether
      // the agent then took it is #179's verdict, watched in [checkUnconfirmedReplies].
      _pendingReply[keyOf(s)] = (text: val, at: sentAt);
      unawaited(repository.refresh());
    }
    return ok;
  }

  /// #179 for the board: a reply the agent's TUI swallowed is reported by the server
  /// as `submitUnconfirmed`. The decision is the session screen's own
  /// ([resolveSubmitUnconfirmedReaction]: only a report stamped at or after this send,
  /// only inside [kSubmitPendingGrace], only into an empty box); this is the glue.
  void checkUnconfirmedReplies(Iterable<Session> sessions) {
    if (_pendingReply.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final s in sessions) {
      final k = keyOf(s);
      final pending = _pendingReply[k];
      if (pending == null) continue;
      final at = repository.submitUnconfirmedAt(s.id);
      final fresh = now - pending.at < kSubmitPendingGrace.inMilliseconds;
      final reaction = resolveSubmitUnconfirmedReaction(
        eventAt: at,
        lastHandledAt: _handledUnconfirmed[k],
        pendingText: fresh ? pending.text : null,
        composeIsEmpty: (_replyBoxes[k]?.text ?? '').isEmpty,
        lastSubmitAt: pending.at,
      );
      if (!fresh) _pendingReply.remove(k);
      if (reaction.outcome == SubmitUnconfirmedOutcome.unchanged) continue;
      _handledUnconfirmed[k] = at;
      if (reaction.outcome == SubmitUnconfirmedOutcome.notMine) continue;
      repository.clearSubmitUnconfirmed(s.id);
      _pendingReply.remove(k);
      if (reaction.restore) replyBox(s).text = reaction.text!;
      say('"${s.name}" did not take your reply'
          '${reaction.restore ? ' - it is back in the box' : ''}. Open it to see what is on its screen.');
    }
  }

  /// A lone Esc: interrupts a working turn, closes a menu over the composer.
  Future<void> esc(Session s) async {
    if (await write(s, (send) async => send('\x1b'))) unawaited(repository.refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    for (final c in _replyBoxes.values) {
      c.dispose();
    }
    super.dispose();
  }
}
