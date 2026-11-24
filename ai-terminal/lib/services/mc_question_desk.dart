// #510 - Mission Control: one question card, read and discussed before it is answered.
//
// [McQuestionDesk] holds what the question panel shows for ONE Answer-now card: the context at
// each level as the server built it (`GET /api/mc/questions/:cardId/context`), the follow-ups
// asked about each option and the Analyst's answers, and the options it suggested. Every call
// goes through [McAnalyst] (the one routing rule for Mission Control's model calls). None of it
// reaches the waiting session: only [McPickSender] does, and only with the person's final pick.

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/mc_ask_models.dart';
import 'mc_analyst.dart';

/// The three levels, in order, with the words the panel shows.
const List<(String, String)> kMcContextLevels = [
  ('ask', 'Just the ask'),
  ('context', 'Context'),
  ('everything', 'Everything'),
];

/// One follow-up and, once it came, the answer or why there is none.
class McFollowup {
  final String question;
  McAnswer? answer;
  String? error;
  McFollowup(this.question);
  bool get pending => answer == null && error == null;
}

class McQuestionDesk extends ChangeNotifier {
  McQuestionDesk({required this.analyst, required this.cardId});

  final McAnalyst analyst;
  final String cardId;

  String _level = 'ask';
  final Map<String, McQuestionContext> _contexts = {};
  bool _loading = false;
  String? _contextError;

  final Map<int?, List<McFollowup>> _followups = {};
  McSuggestions? _suggestions;
  bool _suggesting = false;
  String? _suggestError;
  bool _disposed = false;

  String get level => _level;
  McQuestionContext? get context => _contexts[_level];

  /// The ask as the server read it: from whichever level came back first.
  McQuestionAsk? get ask => context?.ask ?? (_contexts.isEmpty ? null : _contexts.values.first.ask);
  bool get loading => _loading;
  String? get contextError => _contextError;

  /// The follow-ups about option [option] (null: the whole question), oldest first.
  List<McFollowup> followupsFor(int? option) => List.unmodifiable(_followups[option] ?? const []);
  bool get followupBusy => _followups.values.any((l) => l.any((f) => f.pending));

  McSuggestions? get suggestions => _suggestions;
  bool get suggesting => _suggesting;
  String? get suggestError => _suggestError;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// Shows [level]; read from the server the first time (or again after a failure).
  Future<void> show(String level) async {
    _level = level;
    _contextError = null;
    if (_contexts.containsKey(level)) {
      _changed();
      return;
    }
    _loading = true;
    _changed();
    try {
      _contexts[level] = await analyst.questionContext(cardId, level);
    } on ApiException catch (e) {
      if (_level == level) _contextError = e.message;
    } catch (e) {
      if (_level == level) _contextError = 'The context could not be read ($e)';
    }
    _loading = false;
    _changed();
  }

  /// Asks the Analyst [question] about option [option]; one follow-up at a time.
  Future<void> followup(int? option, String question) async {
    final q = question.trim();
    if (q.isEmpty || followupBusy) return;
    final f = McFollowup(q);
    (_followups[option] ??= []).add(f);
    _changed();
    try {
      f.answer = await analyst.followup(cardId, option, q);
    } on ApiException catch (e) {
      f.error = e.message;
    } catch (e) {
      f.error = 'The answer could not be read ($e)';
    }
    _changed();
  }

  /// Asks the Analyst for more options.
  Future<void> suggest() async {
    if (_suggesting) return;
    _suggesting = true;
    _suggestError = null;
    _changed();
    try {
      _suggestions = await analyst.suggest(cardId);
    } on ApiException catch (e) {
      _suggestError = e.message;
    } catch (e) {
      _suggestError = 'The options could not be read ($e)';
    }
    _suggesting = false;
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
