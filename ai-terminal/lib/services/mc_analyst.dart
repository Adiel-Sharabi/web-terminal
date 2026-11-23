// #511 - Mission Control Ask: the app's side of `POST /api/mc/ask`.
//
// [McAnalyst] sends a question to the server that answers Mission Control, by the rule the
// feed uses (lib/services/mc_feed.dart): the server that answered Mission Control last is
// asked first; a 409 peer answer names the authority, asked next by url
// ([serverForAuthority]); a transport failure moves on to the next server. Any other answer
// is final: a 404 naming what is unknown, a 400, a 502/503 with the reason in words.
// Later screens (#509's "Ask about this subject", #510's follow-ups) call [McAnalyst.ask]
// with their own scope.
//
// [McAskThread] is one conversation: the questions asked from one place and their answers,
// kept while the screen that shows them comes and goes.

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/mc_ask_models.dart';
import '../api/models.dart';
import 'mc_feed.dart' show serverForAuthority;

class McAnalyst {
  McAnalyst({required this.servers, required this.client, this.preferred});

  final List<ServerConfig> Function() servers;
  final ApiClient Function(ServerConfig) client;

  /// The server that answered Mission Control last (the feed's), asked first; null: none yet.
  final ServerConfig? Function()? preferred;

  ServerConfig? _last;

  /// The server the last answer came from.
  ServerConfig? get answeredBy => _last;

  /// Asks [question] about [scope]. Throws [ApiException] with words to show.
  Future<McAnswer> ask(String question, McAskScope scope) async {
    final list = servers();
    if (list.isEmpty) throw const ApiException(0, 'Add a server first: the Analyst reads Mission Control');
    final first = preferred?.call() ?? _last;
    final order = [
      for (final sv in list)
        if (first != null && sv.baseUrl == first.baseUrl) sv,
      for (final sv in list)
        if (first == null || sv.baseUrl != first.baseUrl) sv,
    ];
    final tried = <String>{};
    ApiException? lastError;

    Future<McAnswer> one(ServerConfig sv) async {
      tried.add(sv.baseUrl);
      final a = await client(sv).mcAsk(question, scope);
      _last = sv;
      return a;
    }

    for (final sv in order) {
      if (tried.contains(sv.baseUrl)) continue;
      try {
        return await one(sv);
      } on McPeerException catch (e) {
        final target = serverForAuthority(list, e.authority);
        if (target == null) {
          throw ApiException(409, "Mission Control is served by ${e.authority.label} - add that server to this app's list");
        }
        if (tried.contains(target.baseUrl)) {
          throw lastError ?? ApiException(0, "Mission Control's server (${target.name}) is not reachable");
        }
        return one(target);
      } on ApiException catch (e) {
        if (e.isTransport) {
          lastError = ApiException(0, '${sv.name}: ${e.message}');
          continue;
        }
        // Express's own 404 (no JSON error): a server from before Ask.
        if (e.status == 404 && e.message == 'Not found') {
          lastError = const ApiException(404, 'This server has no Ask yet: it arrives with a server update');
          continue;
        }
        rethrow;
      }
    }
    throw lastError ?? const ApiException(0, 'No server answered for Mission Control');
  }
}

/// One question and, once it came, its answer or why there is none.
class McAskExchange {
  final String question;
  final McAskScope scope;
  final String scopeLabel;
  final DateTime askedAt;
  McAnswer? answer;
  String? error;

  McAskExchange({required this.question, required this.scope, required this.scopeLabel, required this.askedAt});

  bool get pending => answer == null && error == null;
}

/// A conversation with the Analyst, newest last. One question at a time.
class McAskThread extends ChangeNotifier {
  McAskThread(this.analyst);

  final McAnalyst analyst;
  final List<McAskExchange> _items = [];
  bool _disposed = false;

  List<McAskExchange> get items => List.unmodifiable(_items);
  bool get busy => _items.isNotEmpty && _items.last.pending;

  /// Asks [question]; the exchange appears at once and fills in when the answer comes.
  Future<void> ask(String question, McAskScope scope, {required String scopeLabel}) async {
    final q = question.trim();
    if (q.isEmpty || busy) return;
    final ex = McAskExchange(question: q, scope: scope, scopeLabel: scopeLabel, askedAt: DateTime.now());
    _items.add(ex);
    notifyListeners();
    try {
      ex.answer = await analyst.ask(q, scope);
    } on ApiException catch (e) {
      ex.error = e.message;
    } catch (e) {
      ex.error = 'The answer could not be read ($e)';
    }
    if (!_disposed) notifyListeners();
  }

  void clear() {
    if (busy) return;
    _items.clear();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
