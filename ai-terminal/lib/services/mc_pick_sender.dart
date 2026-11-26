// #510 - the person's final pick on a question card, sent to the waiting session through the
// EXISTING answer paths, never a new one:
//   - a decision card (#492): the reported-wait reply `Decision: <label>`, sent only while the
//     session still puts THAT decision (the questions inbox's rule);
//   - a reported "you" wait: the reply, while [replyStillWanted];
//   - an ask (#526), a decision the session holds without stopping for it: the reply, behind the
//     card's own `replyPrefix` (the server's words, naming WHICH decision it answers: the server
//     ends exactly that ask when the answer arrives), while the session still holds it; a pick
//     of its option is the label, behind the same prefix;
//   - a possible unreported question (#526), a guess the server quotes from the session's last
//     reply: the reply as the person's own words, while the session's reply still ends on it;
//   - an AskUserQuestion on screen: its `Other` row, through [buildAnswerFrames] with the text
//     as `otherText` and [NeedsYouActions.answer] (the pre-write re-check, the server-typed
//     frames, the landing check). `Other` exists only for a COMPACT question (CLAUDE.md
//     "AskUserQuestion"), and one question only, so a side-by-side or multi-tab question is
//     refused here with nothing written.
// A suggestion is made for ONE wait, and minutes can pass before it is picked: before any key,
// the card is read again ([currentAsk]: the card id names the wait, so a newer question or wait
// is a 404) and must still ask what the panel showed; a question on screen must still read the
// same. The follow-ups and the suggestions themselves never come here: they are the Analyst's.
//
// #531 - the card's OWN question is answered here too, in Mission Control: the answer sheet
// reads the question on screen ([pendingQuestion]) and sends the frames the answer panel built
// from the person's picks ([answerQuestion]) - buildAnswerFrames stays the one copy of the key
// rules, and NeedsYouActions.answer the one writer, with its pre-write re-check of what the
// person saw against what the session still asks.

import '../api/api_client.dart' show ApiException;
import '../api/mc_ask_models.dart';
import '../api/mc_models.dart';
import '../api/models.dart';
import '../util/needs_you.dart' show replyStillWanted;
import '../widgets/question_overlay.dart' show AnswerFrame, buildAnswerFrames;
import 'needs_you_actions.dart';

/// The session [card] is about among [sessions], or null when it is not known or not one session.
/// A cluster peer's name and this app's name for that server can differ in case. The ONE lookup:
/// the pick sender writes to this session and the card's context sheet (#571) reads it.
Session? mcSessionOfCard(Iterable<Session> sessions, McCard card) {
  final id = card.sessionId;
  if (id == null) return null;
  final server = card.server?.toLowerCase();
  final hits = [
    for (final s in sessions)
      if (s.id == id && (server == null || s.server.name.toLowerCase() == server)) s,
  ];
  return hits.length == 1 ? hits.single : null;
}

class McPickSender {
  McPickSender({required this.actions, required this.sessions, required this.currentAsk});

  /// The writers (one write per session at a time, the re-reads before each).
  final NeedsYouActions actions;

  /// The sessions the app knows now (the repository's current list).
  final List<Session> Function() sessions;

  /// The card's ask as the server reads it NOW; null when the card no longer waits (or that
  /// cannot be read: nothing is written on no evidence).
  final Future<McQuestionAsk?> Function(McCard card) currentAsk;

  /// The card's session, or null when it is not known or not one session. A cluster peer's
  /// name and this app's name for that server can differ in case.
  Session? sessionOf(McCard card) => mcSessionOfCard(sessions(), card);

  /// The AskUserQuestion on [card]'s session's screen, from the route the session screen's
  /// overlay reads; null when nothing is pending. Throws [ApiException] when the session is not
  /// known to this app or the read fails: the answer sheet says so, it never guesses.
  Future<PendingQuestion?> pendingQuestion(McCard card) async {
    final s = sessionOf(card);
    if (s == null) {
      throw const ApiException(0, "That session is not in this app's list - open it to answer");
    }
    return actions.client(s.server).pendingQuestion(s.id);
  }

  /// Answers [shown] - the question the person saw - with [frames] the answer panel built
  /// ([buildAnswerFrames]), through [NeedsYouActions.answer]: the question is read again just
  /// before the first key and compared by content, so an answer to a question that has since
  /// gone or changed writes nothing. True when the keys went out; otherwise the reason was said.
  Future<bool> answerQuestion(McCard card, PendingQuestion shown, List<AnswerFrame> frames) async {
    final s = sessionOf(card);
    if (s == null) {
      actions.say("That session is not in this app's list - open it to answer, nothing was sent");
      return false;
    }
    if (actions.quickAnswerBlocked(s, shown)) {
      actions.say('An answer to "${s.name}" did not land - open it to finish, nothing was sent');
      return false;
    }
    return await actions.answer(s, shown, frames) == PreWriteVerdict.proceed;
  }

  /// Whether [text] would run as a command at the agent's prompt rather than be read as words.
  static bool runsAsCommand(String text) => text.startsWith('!') || text.startsWith('/');

  /// Sends [text] as the answer to [card], whose ask the panel showed as [shown]. True when it
  /// went out; otherwise the reason was said through [NeedsYouActions.say] and nothing was written.
  Future<bool> send(McCard card, String text, {McQuestionAsk? shown}) async {
    final words = text.trim();
    if (words.isEmpty) return false;
    final s = sessionOf(card);
    if (s == null) {
      actions.say('That session is not in this app\'s list - open it to answer, nothing was sent');
      return false;
    }
    final fresh = await currentAsk(card);
    if (fresh == null) {
      actions.say('"${s.name}" no longer asks that - nothing was sent');
      return false;
    }
    final asked = shown?.questions ?? fresh.questions;
    if (!_same(fresh.questions, asked)) {
      actions.say('"${s.name}" asks something else now - nothing was sent');
      return false;
    }
    switch (card.kind) {
      case 'decision':
        final d = s.brief?.decision;
        if (d == null || (card.decision != null && !d.sameAsk(card.decision))) {
          actions.say('"${s.name}" asks something else now - nothing was sent');
          return false;
        }
        return actions.reply(s, 'Decision: $words',
            still: (fresh) => replyStillWanted(fresh) && d.sameAsk(fresh.brief?.decision),
            movedOn: '"${s.name}" asks something else now - nothing was sent');
      case 'ask':
        final prefix = card.replyPrefix;
        final askId = card.askId;
        if (prefix == null || askId == null) {
          // An answer that does not name its decision would only mark every ask "maybe answered".
          actions.say('This server does not name the decision to answer - open the session to reply, nothing was sent');
          return false;
        }
        return actions.reply(s, '$prefix$words',
            still: (fresh) => fresh.brief?.asks.any((a) => a.id == askId) ?? false,
            movedOn: '"${s.name}" no longer asks that - nothing was sent');
      case 'possible-ask':
        if (runsAsCommand(words)) {
          actions.say('That would run as a command in "${s.name}", not be read as an answer - nothing was sent');
          return false;
        }
        final quoted = card.what;
        return actions.reply(s, words,
            still: (fresh) => quoted != null && fresh.brief?.possibleAsk?.text == quoted,
            movedOn: '"${s.name}" no longer asks that - nothing was sent');
      case 'wait':
        if (runsAsCommand(words)) {
          actions.say('That would run as a command in "${s.name}", not be read as an answer - nothing was sent');
          return false;
        }
        return actions.reply(s, words,
            still: replyStillWanted, movedOn: '"${s.name}" is no longer waiting on you - nothing was sent');
      case 'question':
        final PendingQuestion? q;
        try {
          q = await actions.client(s.server).pendingQuestion(s.id);
        } catch (_) {
          actions.say('Could not read "${s.name}"\'s question, so nothing was sent');
          return false;
        }
        if (q == null || q.questions.isEmpty) {
          actions.say('"${s.name}" is no longer asking it - nothing was sent');
          return false;
        }
        if (q.questions.length != 1 || q.questions.single.hasPreview) {
          actions.say('This question takes no typed answer here - open it to answer, nothing was sent');
          return false;
        }
        if (asked.length != 1 || q.questions.single.question.trim() != asked.single.trim()) {
          actions.say('"${s.name}" asks something else now - nothing was sent');
          return false;
        }
        if (actions.quickAnswerBlocked(s, q)) {
          actions.say('An answer to "${s.name}" did not land - open it to finish, nothing was sent');
          return false;
        }
        final frames = buildAnswerFrames(q.questions, [<int>{}], otherText: [words]);
        return await actions.answer(s, q, frames) == PreWriteVerdict.proceed;
      default:
        actions.say('A permission is answered on its own screen - nothing was sent');
        return false;
    }
  }

  static bool _same(List<String> a, List<String> b) =>
      a.length == b.length && [for (var i = 0; i < a.length; i++) a[i].trim() == b[i].trim()].every((x) => x);
}
