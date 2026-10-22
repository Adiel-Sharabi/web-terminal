// The writers behind a "needs you" card (#337, extracted for #383): answer a question,
// reply to a session that said it is waiting, send a lone Esc. The sessions board owns
// one of these, and the questions inbox will own another, so the two can never come to
// write different bytes for the same card.
//
// None of it decides WHAT to write. A question's keys come from [buildAnswerFrames]
// (the caller builds them), a reply is [buildComposeSubmission], Esc is a lone `0x1b`;
// all of them travel through [SessionInputRunner], the session's own `/ws/:id` socket.
// This holds the state around those writes: one write per session at a time (from
// the press), the re-read before each one, the answered-and-landing questions, the
// replies awaiting #179's verdict, and the cached live questions behind the cards.

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../screens/session_screen.dart'
    show
        AnswerVerification,
        SubmitUnconfirmedOutcome,
        buildComposeSubmission,
        kSubmitPendingGrace,
        questionSignature,
        resolveSubmitUnconfirmedReaction,
        shouldClearQuestionDrafts,
        verifyAnswerLanded;
import '../util/inbox_items.dart' show sessionKey;
import '../widgets/question_answer_panel.dart' show quickAnswerable;
import '../widgets/question_overlay.dart' show AnswerFrame, answerNeedsConfirm, buildAnswerFrames, deliverAnswerFrames;
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

  /// Sessions with a write in flight, from the PRESS until the write has ended: the
  /// re-read or re-check before it takes a round trip (up to the client's deadline
  /// when a peer is offline), and a second press inside it must not start a second
  /// write (#383).
  final Set<String> _busy = {};

  /// The signature of a question answered from here, by [keyOf]: its buttons stay
  /// down until the server stops reporting it, so it cannot be answered twice.
  final Map<String, String> _answered = {};

  /// An answer whose keys went out but whose landing no poll saw (every check failed),
  /// by [keyOf], with when it settled. Its card says "landing" only until a read made
  /// after that moment sees the session again (#383): it cannot sit there for good.
  final Map<String, DateTime> _unverified = {};

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
  static String keyOf(Session s) => sessionKey(s);

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
    _unverified.removeWhere((k, _) => !live.contains(k));
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
      final PendingQuestion? fresh;
      try {
        fresh = await client(s.server).pendingQuestion(s.id);
      } catch (_) {
        return; // keep what is shown; the card still offers Open. A failed poll observes nothing.
      }
      _observe(s, fresh, now);
    }));
    _changed();
  }

  /// What one successful read of [s]'s question, asked at [askedAt], settles (#383).
  void _observe(Session s, PendingQuestion? fresh, DateTime askedAt) {
    final k = keyOf(s);
    _questions[k] = fresh;
    // The session's drafts outlive the session screen, whose 4 s poll used to be the
    // only thing that cleared them. So a not-landed flag is dropped here too, on the
    // same rule: a POSITIVE gone-or-different observation. Only a flagged draft: its
    // words were sent and are shown nowhere, while unsent words stay keyed to the
    // question they were typed for (no other question restores them), and the inbox
    // shows them under its "no longer waiting" banner.
    final d = QuestionDraftStore.instance.peek(s.server.baseUrl, s.id);
    if (d != null && d.notLanded && shouldClearQuestionDrafts(draftKey: d.key, observed: true, current: fresh)) {
      d.clear();
    }
    // An answer nobody saw land stops saying "landing" once a read made AFTER it
    // settled sees the session: still asked, it is back to the not-landed state (its
    // buttons, or the flag's notice); gone or replaced, the card follows the read.
    final since = _unverified[k];
    if (since != null && !askedAt.isBefore(since) && !_busy.contains(k)) {
      _unverified.remove(k);
      _answered.remove(k);
    }
  }

  /// Runs [run] as THE write to [s], holding [s] busy from now (the press) until it
  /// ends, however it ends. Null, with nothing run, while another write to [s] is in
  /// flight.
  Future<T?> _exclusive<T>(Session s, Future<T> Function() run) async {
    final k = keyOf(s);
    if (_busy.contains(k)) return null;
    _busy.add(k);
    _changed();
    try {
      return await run();
    } finally {
      _busy.remove(k);
      _changed();
    }
  }

  /// Opens [s]'s socket and runs [body] once it is attached. False when it could not
  /// be reached, which is said out loud: nothing was sent.
  Future<bool> _send(Session s, Future<void> Function(void Function(String keys) send) body) async {
    final ok = await input(s, body);
    if (!ok) say('Could not reach "${s.name}" - nothing was sent');
    return ok;
  }

  /// [s]'s row read again just now, from its OWN server, when [still] holds for it;
  /// otherwise null, with the reason said. A card can be a poll old, and a reply or an
  /// Esc that reaches a session which has moved on is some other input (#383).
  ///
  /// A server that did not answer refuses, as a failed question poll refuses an answer
  /// ([preWriteVerdict]): its last-known row is the very row the card was drawn from,
  /// so it is no evidence of anything.
  Future<Session?> _stillThere(Session s, bool Function(Session fresh) still, String movedOn) async {
    final answered = await repository.refreshServer(s.server.baseUrl);
    if (_disposed) return null;
    if (!answered) {
      say('Could not check "${s.name}" - nothing was sent');
      return null;
    }
    final fresh = repository.current.where((x) => keyOf(x) == keyOf(s)).firstOrNull;
    if (fresh == null || !still(fresh)) {
      say(movedOn);
      return null;
    }
    return fresh;
  }

  /// Answers [shown], the question on [s]'s card, with [frames] (built by
  /// [buildAnswerFrames]), through the overlay's own pacing and confirm (#19).
  ///
  /// The question is read again first ([preWriteVerdict]), on the ATTACHED socket just
  /// before the first key, and anything but [PreWriteVerdict.proceed] writes nothing.
  /// A question still up after every check is put back, with a word that it did not
  /// take. The session's drafts ([QuestionDraftStore]) follow the session screen's
  /// rules: flagged as an answer carrying words goes out, cleared only when a poll
  /// positively saw the question go.
  ///
  /// [onSettled] hears once the keys have gone out and been checked: true only when a
  /// poll SAW the question go (or be replaced), false when it is still up or no check
  /// answered. It is not called when nothing was written.
  Future<PreWriteVerdict> answer(Session s, PendingQuestion shown, List<AnswerFrame> frames,
      {void Function(bool landed)? onSettled}) async {
    final k = keyOf(s);
    final sig = questionSignature(shown);
    var verdict = PreWriteVerdict.refused;
    var polled = false;
    PendingQuestion? fresh;
    AnswerVerification? checked;
    final reached = await _exclusive(s, () {
      // Down from the press, so the card cannot offer a second answer meanwhile.
      _answered[k] = sig;
      _unverified.remove(k);
      _changed();
      return _send(s, (send) async {
        // The re-check runs HERE, once the socket is attached and right before the
        // first key: the attach can take seconds, and a question answered elsewhere
        // inside them must not get a digit and a CR in its composer (#383).
        var pollFailed = false;
        try {
          fresh = await client(s.server).pendingQuestion(s.id);
          polled = true;
        } catch (_) {
          pollFailed = true;
        }
        if (_disposed) return; // the screen went: nothing more goes out
        verdict = preWriteVerdict(sig, fresh, pollFailed);
        if (verdict != PreWriteVerdict.proceed) return;
        final drafts = QuestionDraftStore.instance.of(s.server.baseUrl, s.id);
        // Flagged as the first key goes out (#383), as the session screen does.
        drafts.markSent(sig, frames);
        await deliverAnswerFrames(frames, send);
        checked = await verifyAnswerLanded(
          answeredKey: sig,
          resendEnter: answerNeedsConfirm(frames),
          poll: () => client(s.server).pendingQuestion(s.id),
          resend: () => send('\r'),
        );
        if (checked!.seen.shouldClearDrafts(drafts.key)) drafts.clear();
      });
    });
    if (reached == null) return PreWriteVerdict.refused;
    if (_disposed) return verdict;
    final v = checked;
    if (v == null) {
      // Nothing was written: not reached (said by [_send]), or the re-check refused.
      _answered.remove(k);
      if (polled) _questions[k] = fresh;
      _changed();
      if (reached) {
        say(switch (verdict) {
          PreWriteVerdict.gone => '"${s.name}" is no longer asking it - nothing was sent',
          PreWriteVerdict.changed => '"${s.name}" is asking something else now - nothing was sent',
          _ => 'Could not check "${s.name}" is still asking it, so nothing was sent',
        });
      }
      return reached ? verdict : PreWriteVerdict.refused;
    }
    final stuck = v.stillPending;
    // Landed only on a POSITIVE observation: [awaitAnswerLanded] also returns null
    // when its poll threw, and that proves nothing either way.
    final landed = v.seen.observed && questionSignature(v.seen.lastSeen) != sig;
    onSettled?.call(landed);
    if (stuck != null) {
      _answered.remove(k);
      say('The answer did not take - open "${s.name}" to answer it there');
    } else if (!landed) {
      _unverified[k] = DateTime.now();
      _questionAt.remove(k); // so the next refresh reads it again at once
      say('Could not check that "${s.name}" took the answer');
    }
    _changed();
    unawaited(repository.refresh());
    return verdict;
  }

  /// A reply to a session that said it is waiting on you: the compose bar's submit,
  /// one frame (#44). Only while [still] holds for [s]'s row read again first
  /// ([_stillThere]); [movedOn] says why not. Refused while the agent is not at its
  /// composer (#147), as the compose bar refuses it.
  Future<bool> reply(Session s, String text,
      {required bool Function(Session fresh) still, required String movedOn}) async {
    final val = text.replaceFirst(RegExp(r'[\r\n]+$'), '');
    if (val.trim().isEmpty) return false;
    final sent = await _exclusive(s, () async {
      final fresh = await _stillThere(s, still, movedOn);
      if (fresh == null) return false;
      if (!fresh.agentReady) {
        say('"${s.name}" is still starting - nothing was sent');
        return false;
      }
      final sentAt = DateTime.now().millisecondsSinceEpoch;
      if (!await _send(fresh, (send) async => send(buildComposeSubmission(val)))) return false;
      // Delivered to an ATTACHED session (see services/session_input.dart). Whether
      // the agent then took it is #179's verdict, watched in [checkUnconfirmedReplies].
      _pendingReply[keyOf(s)] = (text: val, at: sentAt);
      unawaited(repository.refresh());
      return true;
    });
    return sent ?? false;
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

  /// An answer from [s]'s session did not land and may be partly typed in its terminal
  /// (#383, [QuestionDrafts.flaggedFor]): a one-press answer is refused for [q] until
  /// that settles, wherever the press comes from. A digit typed now could land in the
  /// Other editor that still holds the earlier text. The full card shows why instead.
  bool quickAnswerBlocked(Session s, PendingQuestion q) =>
      QuestionDraftStore.instance.peek(s.server.baseUrl, s.id)?.flaggedFor(questionSignature(q)) ?? false;

  /// A one-press answer: option [index] of [q]'s only question. Refused, with nothing
  /// written, unless one press IS the whole answer ([quickAnswerable]) and while
  /// [quickAnswerBlocked]; otherwise [answer] with the overlay's frames.
  Future<PreWriteVerdict> quickAnswer(Session s, PendingQuestion q, int index,
      {void Function(bool landed)? onSettled}) async {
    if (!quickAnswerable(q) || index < 0 || index >= q.questions.first.options.length) {
      say('"${s.name}" needs more than one press to answer - open it, nothing was sent');
      return PreWriteVerdict.refused;
    }
    if (quickAnswerBlocked(s, q)) {
      say('An answer to "${s.name}" did not land - open it to finish, nothing was sent');
      // The flag was set elsewhere (the session screen) since this card drew its
      // buttons: redraw it without them.
      _changed();
      return PreWriteVerdict.refused;
    }
    return answer(
        s,
        q,
        buildAnswerFrames(q.questions, [
          {index},
        ]),
        onSettled: onSettled);
  }

  /// A lone Esc: interrupts a working turn, closes a menu over the composer. Only while
  /// [still] holds for [s]'s row read again first ([_stillThere]); [movedOn] says why
  /// not.
  Future<void> esc(Session s, {required bool Function(Session fresh) still, required String movedOn}) async {
    await _exclusive(s, () async {
      final fresh = await _stillThere(s, still, movedOn);
      if (fresh == null) return;
      if (await _send(fresh, (send) async => send('\x1b'))) unawaited(repository.refresh());
    });
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
