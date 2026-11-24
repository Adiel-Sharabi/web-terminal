// #510 - the person's final pick on a question card, sent to the waiting session through the
// EXISTING answer paths, never a new one:
//   - a decision card (#492): the reported-wait reply `Decision: <label>`, sent only while the
//     session still puts THAT decision (the questions inbox's rule);
//   - a reported "you" wait: the reply, while [replyStillWanted];
//   - an AskUserQuestion on screen: its `Other` row, through [buildAnswerFrames] with the text
//     as `otherText` and [NeedsYouActions.answer] (the pre-write re-check, the server-typed
//     frames, the landing check). `Other` exists only for a COMPACT question (CLAUDE.md
//     "AskUserQuestion"), and one question only, so a side-by-side or multi-tab question is
//     refused here with nothing written.
// The follow-ups and the suggestions themselves never come here: they are the Analyst's.

import '../api/mc_models.dart';
import '../api/models.dart';
import '../util/needs_you.dart' show replyStillWanted;
import '../widgets/question_overlay.dart' show buildAnswerFrames;
import 'needs_you_actions.dart';

class McPickSender {
  McPickSender({required this.actions, required this.sessions});

  /// The writers (one write per session at a time, the re-reads before each).
  final NeedsYouActions actions;

  /// The sessions the app knows now (the repository's current list).
  final List<Session> Function() sessions;

  /// The card's session, or null when it is not known or not one session.
  Session? sessionOf(McCard card) {
    final id = card.sessionId;
    if (id == null) return null;
    final hits = [
      for (final s in sessions())
        if (s.id == id && (card.server == null || s.server.name == card.server)) s,
    ];
    return hits.length == 1 ? hits.single : null;
  }

  /// Sends [text] as the answer to [card]. True when it went out; otherwise the reason was
  /// said through [NeedsYouActions.say] (or here) and nothing was written.
  Future<bool> send(McCard card, String text) async {
    final words = text.trim();
    if (words.isEmpty) return false;
    final s = sessionOf(card);
    if (s == null) {
      actions.say('That session is not in this app\'s list - open it to answer, nothing was sent');
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
      case 'wait':
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
}
