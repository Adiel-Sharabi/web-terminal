// #466/#492 - the ONE probe of the cluster for its supervisor: ask every configured server
// `GET /api/supervisor/state` and read the answers with [findSupervisor]. The Journal page
// and the questions inbox both ask through here, so they can never disagree about which
// server is the supervisor or why none is found.

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../util/supervisor_authority.dart';

/// #498 - the latest supervisor answer, shared: the inbox publishes what it asked, and the
/// dashboard's badge reads it (asking on its own tick while no inbox is open), so the badge
/// and the inbox header count the SAME "need you" list (`needYouOf`).
class SupervisorFeed extends ChangeNotifier {
  SupervisorFeed._();
  static final SupervisorFeed instance = SupervisorFeed._();

  SupervisorFind? _find;
  DateTime? _at;
  bool _asking = false;

  /// The last answer, or null before the first.
  SupervisorFind? get find => _find;

  void publish(SupervisorFind f) {
    _find = f;
    _at = DateTime.now();
    notifyListeners();
  }

  /// Asks again unless an answer is younger than [minAge] or a question is out.
  Future<void> refresh(List<ServerConfig> servers, ApiClient Function(ServerConfig) client,
      {Duration minAge = const Duration(seconds: 20)}) async {
    final at = _at;
    if (_asking || (at != null && DateTime.now().difference(at) < minAge)) return;
    _asking = true;
    try {
      publish(await askSupervisor(servers, client));
    } finally {
      _asking = false;
    }
  }

  @visibleForTesting
  void resetForTest() {
    _find = null;
    _at = null;
    _asking = false;
  }
}

/// Asks every one of [servers] (through [client]) for its supervisor state, in parallel,
/// and reads the answers. A server that fails is that server's answer, never an exception.
Future<SupervisorFind> askSupervisor(List<ServerConfig> servers, ApiClient Function(ServerConfig) client) async {
  final probes = <String, SupervisorProbe>{};
  await Future.wait(servers.map((sv) async {
    try {
      probes[sv.baseUrl] = SupervisorProbe.answered(await client(sv).supervisorState());
    } on ApiException catch (e) {
      probes[sv.baseUrl] = SupervisorProbe.failed(e.status, e.message);
    } catch (e) {
      // Not swallowed: it is this server's answer, said on the page like any failure.
      probes[sv.baseUrl] = SupervisorProbe.failed(0, 'unreadable answer ($e)');
    }
  }));
  return findSupervisor(servers, probes);
}
