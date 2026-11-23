// #507 - Mission Control's data, for every MC screen: which server answers it, and its
// last answer to `GET /api/mc/now`.
//
// Mission Control is computed on ONE server per cluster (the lease authority). The app
// does not know which, so it asks its servers in order, and reads the answers with ONE
// rule, here:
//   * a 200 is the answer, from the server that gave it (remembered and asked first next);
//   * a 409 peer answer names the authority: the configured server whose url matches
//     (else whose name matches) is asked next. Not in this app's list: the screen says
//     "served by <name> - add that server". In the list but not answering: says that;
//   * a 404 is a server without Mission Control yet. Every server saying so is the
//     screen's "this server has no Mission Control yet", never a crash or an empty list;
//   * a transport failure is that server's answer, said when nobody else answers.
// A failed refresh keeps the last answer on screen with the reason beside it: an older
// list that says how old it is beats a blank one.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/mc_models.dart';
import '../api/models.dart';

enum McStatus {
  /// No answer yet.
  loading,

  /// [McFeed.now] is the authority's answer.
  ok,

  /// No server is configured.
  noServers,

  /// Every answering server is too old for `/api/mc` (404).
  unsupported,

  /// A peer named the authority, and no configured server is it.
  notListed,

  /// Nobody answered (the authority included, when one was named).
  unreachable,
}

/// The configured server [authority] names: url first (scheme, host and port, case- and
/// trailing-slash-insensitive), else the name (case-insensitive), else null.
ServerConfig? serverForAuthority(List<ServerConfig> servers, McAuthority authority) {
  final want = _origin(authority.url);
  if (want != null) {
    for (final sv in servers) {
      if (_origin(sv.baseUrl) == want) return sv;
    }
  }
  final name = authority.name?.toLowerCase();
  if (name != null) {
    for (final sv in servers) {
      if (sv.name.toLowerCase() == name) return sv;
    }
  }
  return null;
}

String? _origin(String? url) {
  if (url == null) return null;
  final u = Uri.tryParse(url.trim());
  if (u == null || u.host.isEmpty) return null;
  final port = u.hasPort ? u.port : (u.scheme == 'https' ? 443 : 80);
  return '${u.scheme.toLowerCase()}://${u.host.toLowerCase()}:$port';
}

class McFeed extends ChangeNotifier {
  McFeed({
    required this.servers,
    required this.client,
    this.pollInterval = const Duration(seconds: 10),
    this.isForeground,
  });

  /// The configured servers, read at every ask.
  final List<ServerConfig> Function() servers;
  final ApiClient Function(ServerConfig) client;

  /// How often [now] is re-read while [active].
  final Duration pollInterval;

  /// Whether the app is in the foreground; a background app does not poll. Null: always.
  final bool Function()? isForeground;

  McStatus _status = McStatus.loading;
  McNow? _now;
  ServerConfig? _servedBy;
  String? _message;
  DateTime? _at;
  bool _asking = false;
  bool _active = false;
  bool _disposed = false;
  Timer? _timer;

  McStatus get status => _status;

  /// The last answer, kept through a failed refresh (with [message] saying why it is old).
  McNow? get now => _now;

  /// The server that answered [now]; actions on a card go to it.
  ServerConfig? get servedBy => _servedBy;

  /// What the screen says instead of (or beside) the data, or null.
  String? get message => _message;

  /// When [now] was received.
  DateTime? get receivedAt => _at;

  /// Polls while true. Mission Control turns it on while it is the home on screen.
  bool get active => _active;
  set active(bool on) {
    if (on == _active) return;
    _active = on;
    _timer?.cancel();
    _timer = null;
    if (on) {
      unawaited(refresh());
      _timer = Timer.periodic(pollInterval, (_) {
        if (isForeground?.call() ?? true) unawaited(refresh());
      });
    }
  }

  /// Asks the servers again (see the file header). One ask at a time.
  Future<void> refresh() async {
    if (_asking || _disposed) return;
    _asking = true;
    try {
      await _ask();
    } finally {
      _asking = false;
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> _ask() async {
    final list = servers();
    if (list.isEmpty) {
      _set(McStatus.noServers, null, null, 'Add a server first: Mission Control reads it from the cluster');
      return;
    }
    // The server that answered last is asked first: usually it is the authority.
    final last = _servedBy;
    final order = [
      for (final sv in list)
        if (last != null && sv.baseUrl == last.baseUrl) sv,
      for (final sv in list)
        if (last == null || sv.baseUrl != last.baseUrl) sv,
    ];
    final asked = <String>{};
    final failures = <String>[];
    final whyNot = <String, String>{};
    McAuthority? named;
    var unsupported = 0;

    Future<bool> tryOne(ServerConfig sv) async {
      asked.add(sv.baseUrl);
      try {
        final now = await client(sv).mcNow();
        _now = now;
        _at = DateTime.now();
        _set(McStatus.ok, now, sv, null);
        return true;
      } on McPeerException catch (e) {
        named ??= e.authority;
      } on ApiException catch (e) {
        if (e.status == 404) {
          unsupported++;
          whyNot[sv.baseUrl] = 'it has no Mission Control yet';
        } else {
          failures.add('${sv.name}: ${e.message}');
          whyNot[sv.baseUrl] = e.message;
        }
      } catch (e) {
        failures.add('${sv.name}: unreadable answer ($e)');
        whyNot[sv.baseUrl] = 'unreadable answer';
      }
      return false;
    }

    for (final sv in order) {
      if (asked.contains(sv.baseUrl)) continue;
      if (await tryOne(sv)) return;
      final a = named;
      if (a != null) {
        final target = serverForAuthority(list, a);
        if (target == null) {
          _fail(McStatus.notListed, "Mission Control is served by ${a.label} - add that server to this app's list");
          return;
        }
        if (!asked.contains(target.baseUrl) && await tryOne(target)) return;
        final why = whyNot[target.baseUrl] ?? 'it does not answer as Mission Control';
        _fail(McStatus.unreachable, "Mission Control's server (${target.name}) is not reachable: $why");
        return;
      }
    }
    if (failures.isEmpty && unsupported > 0) {
      _set(McStatus.unsupported, null, null,
          'This server has no Mission Control yet: it arrives with a server update');
      return;
    }
    _fail(McStatus.unreachable,
        failures.isEmpty ? 'No server answered for Mission Control' : 'No server answered: ${failures.join('; ')}');
  }

  /// A failure keeps the last answer (if any) on screen, with the reason as [message].
  void _fail(McStatus status, String message) {
    if (_now != null && status == McStatus.unreachable) {
      _message = message;
      return;
    }
    _set(status, null, null, message);
  }

  void _set(McStatus status, McNow? now, ServerConfig? by, String? message) {
    _status = status;
    _now = now;
    _servedBy = by;
    _message = message;
    if (now == null) _at = null;
  }

  // --- actions on a card or a to-do: sent to the server that answered ------

  ApiClient _authority() {
    final sv = _servedBy;
    if (sv == null) throw const ApiException(0, 'Mission Control is not reachable right now');
    return client(sv);
  }

  /// Moves [card] to My to-do. Returns what to tell the person.
  Future<String> addTodo(McCard card, {String? text}) async {
    final r = await _authority().mcAddTodo(card.id, text: text);
    unawaited(refresh());
    if (r.delivered) return 'On your to-do list; the session was told to carry on';
    final why = r.refused;
    return why == null ? 'On your to-do list' : 'On your to-do list, but the session was not told: $why';
  }

  /// Hides [card] for [hours].
  Future<String> later(McCard card, int hours) async {
    await _authority().mcLater(card.id, hours);
    unawaited(refresh());
    return hours == 1 ? 'Hidden for an hour' : 'Hidden for $hours hours';
  }

  /// `done`, `reopen` or `back` (to Answer now).
  Future<void> todoAction(McTodo todo, String action) async {
    await _authority().mcTodoAction(todo.id, action);
    unawaited(refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
