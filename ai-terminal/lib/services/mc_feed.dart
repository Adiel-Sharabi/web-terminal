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
//
// #561 - beside Now the feed reads the efforts (`GET /api/mc/efforts`) from the server that
// answered Now. A 404 is an authority without them: [efforts] stays null and the Now screen
// is what shows (asked again after [kEffortsRetry], so an upgrade is picked up). Any other
// failure keeps the last efforts on screen with [effortsMessage] saying why they are old.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/mc_models.dart';
import '../api/models.dart';

/// How long an authority that answered 404 to the efforts is left alone before it is asked again.
const Duration kEffortsRetry = Duration(minutes: 5);

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

/// The configured server whose url is [authority]'s (scheme, host, port and path; case,
/// default-port and trailing-slash insensitive), else null. By url ONLY, as the contract
/// says: a same-named server elsewhere may be another install with its own state, and
/// to-dos sent there would land in the wrong place.
ServerConfig? serverForAuthority(List<ServerConfig> servers, McAuthority authority) =>
    serverForUrl(servers, authority.url);

/// The configured server at [url] (the same url rule as [serverForAuthority]), else null.
/// A session's own server (#509's pause) is found this way: by url only, never by name.
ServerConfig? serverForUrl(List<ServerConfig> servers, String? url) {
  final want = _place(url);
  if (want == null) return null;
  for (final sv in servers) {
    if (_place(sv.baseUrl) == want) return sv;
  }
  return null;
}

String? _place(String? url) {
  if (url == null) return null;
  final u = Uri.tryParse(url.trim());
  if (u == null || u.host.isEmpty) return null;
  final port = u.hasPort ? u.port : (u.scheme == 'https' ? 443 : 80);
  var path = u.path;
  while (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  return '${u.scheme.toLowerCase()}://${u.host.toLowerCase()}:$port$path';
}

/// #550 - an answer that went out to a card's session, from wherever in the app it was typed: the
/// card, the answer sheet, the ask dialog. [seq] tells one answer from the next; [shown] is what
/// the card's "Answered" row says (the option's label or the person's words; null: keys were typed).
class McSent {
  const McSent(this.seq, this.shown);
  final int seq;
  final String? shown;
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
  McEfforts? _efforts;
  String? _effortsMessage;
  final Map<String, DateTime> _noEfforts = {};
  ServerConfig? _servedBy;
  String? _message;
  DateTime? _at;
  bool _asking = false;
  bool _again = false;
  bool _active = false;
  bool _disposed = false;
  Timer? _timer;
  Timer? _hurryTimer;

  /// #550 - bumped when the person asks to see the latest list (see [seenEpoch]).
  int _seenEpoch = 0;
  bool _showWanted = false;

  McStatus get status => _status;

  /// The last answer, kept through a failed refresh (with [message] saying why it is old).
  McNow? get now => _now;

  /// #561 - the last efforts the authority sent, kept through a failed read; null when it has
  /// none (an older server, or not read yet): the Now screen shows then.
  McEfforts? get efforts => _efforts;

  /// Why [efforts] are old (their last read failed), or null.
  String? get effortsMessage => _effortsMessage;

  /// The server that answered [now]; actions on a card go to it.
  ServerConfig? get servedBy => _servedBy;

  /// What the screen says instead of (or beside) the data, or null.
  String? get message => _message;

  /// When [now] was received.
  DateTime? get receivedAt => _at;

  /// #550 - changes whenever the person asks to see what is there NOW: pull-to-refresh, the Refresh
  /// button, the "N new" pill, coming back to Mission Control. Between two changes the Now screen
  /// holds back the cards that arrived since it last showed the list, so the one the person is
  /// working on never moves because another one popped up.
  int get seenEpoch => _seenEpoch;

  /// #550 - the answers that went out to cards the server still lists, by card id.
  final Map<String, McSent> _sent = {};
  int _sentSeq = 0;

  /// The latest answer that went out for card [id] and that the server still lists; null: none.
  McSent? sentFor(String id) => _sent[id];

  /// #550 - an answer to [card] went out. Every card that lists it folds into its "Answered" row at
  /// once (not only the one the answer was typed on), and Now is read again every couple of seconds
  /// ([hurry]): the card leaves the server's list long before the next poll.
  void answerWentOut(McCard card, {String? shown}) {
    if (_disposed) return;
    _sent[card.id] = McSent(++_sentSeq, shown);
    notifyListeners();
    hurry();
  }

  /// #550 - the person asks to see the latest list: the cards held back are shown. No network.
  void showLatest() {
    if (_disposed) return;
    _seenEpoch++;
    notifyListeners();
  }

  /// Polls while true. Mission Control turns it on while it is the home on screen.
  bool get active => _active;
  set active(bool on) {
    if (on == _active) return;
    _active = on;
    _timer?.cancel();
    _timer = null;
    if (!on) _stopHurry();
    if (on) {
      // Coming back to Mission Control shows the latest list (#550).
      _showWanted = true;
      unawaited(refresh());
      _timer = Timer.periodic(pollInterval, (_) {
        if (isForeground?.call() ?? true) unawaited(refresh());
      });
    }
  }

  /// Asks the servers again (see the file header). One ask at a time; an ask made while
  /// one is out (after a to-do or a Later, say) runs once it is back, never dropped.
  /// [show]: the person asked to see the latest list (#550): once an answer that was asked for
  /// AFTER this call arrives, [seenEpoch] changes with it, so the Now screen merges in the cards
  /// it held back. A poll or an action's follow-up passes none.
  Future<void> refresh({bool show = false}) async {
    if (_disposed) return;
    if (show) _showWanted = true;
    if (_asking) {
      _again = true;
      return;
    }
    _asking = true;
    try {
      do {
        _again = false;
        final showThis = _showWanted;
        _showWanted = false;
        await _ask();
        if (showThis) _seenEpoch++;
        if (!_disposed) notifyListeners();
      } while (_again && !_disposed);
    } finally {
      _asking = false;
    }
  }

  /// #550 - an answer just went out: the card it answers leaves the server's list within a few
  /// seconds (the session's server clears it in well under one, then Mission Control's server
  /// re-reads the cluster), but the next poll is up to [pollInterval] away. Asks again every
  /// [every] for [span] (longer than the card's grace, so a card still listed then is read as not
  /// taken), then the usual poll resumes. A second call restarts the window.
  void hurry({Duration every = const Duration(seconds: 2), Duration span = const Duration(seconds: 24)}) {
    if (_disposed || !_active) return;
    _stopHurry();
    final ticks = span.inMilliseconds ~/ every.inMilliseconds;
    _hurryTimer = Timer.periodic(every, (t) {
      if (_disposed || !_active || t.tick > ticks) {
        t.cancel();
        if (identical(_hurryTimer, t)) _hurryTimer = null;
        return;
      }
      if (isForeground?.call() ?? true) unawaited(refresh());
    });
    unawaited(refresh());
  }

  void _stopHurry() {
    _hurryTimer?.cancel();
    _hurryTimer = null;
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
        final c = client(sv);
        // Read beside Now: it never throws, so a failed Now leaves nothing unawaited.
        final efforts = _readEfforts(sv, c);
        final now = await c.mcNow();
        _applyEfforts(sv, await efforts);
        _now = now;
        _at = DateTime.now();
        // An answer for a card the server no longer lists has done its work.
        _sent.removeWhere((id, _) => !now.answerNow.any((c) => c.id == id));
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

  /// #561 - the efforts of [sv], as (answer, unsupported, why not). A server that said 404 within
  /// [kEffortsRetry] is not asked again. Never throws.
  Future<(McEfforts?, bool, String?)> _readEfforts(ServerConfig sv, ApiClient c) async {
    final skip = _noEfforts[sv.baseUrl];
    if (skip != null && DateTime.now().isBefore(skip)) return (null, true, null);
    try {
      return (await c.mcEfforts(), false, null);
    } on McPeerException {
      return (null, false, 'it is not the Mission Control server');
    } on ApiException catch (e) {
      return e.status == 404 ? (null, true, null) : (null, false, e.message);
    } catch (e) {
      return (null, false, 'unreadable answer');
    }
  }

  void _applyEfforts(ServerConfig sv, (McEfforts?, bool, String?) r) {
    final (efforts, unsupported, why) = r;
    // Another server's efforts are never kept under this one's Now.
    if (_servedBy != null && _servedBy!.baseUrl != sv.baseUrl) _efforts = null;
    if (efforts != null) {
      _noEfforts.remove(sv.baseUrl);
      _efforts = efforts;
      _effortsMessage = null;
    } else if (unsupported) {
      _noEfforts[sv.baseUrl] = DateTime.now().add(kEffortsRetry);
      _efforts = null;
      _effortsMessage = null;
    } else {
      _effortsMessage = _efforts == null ? null : 'Efforts could not be read: ${why ?? 'no answer'}';
    }
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
    if (now == null) {
      _at = null;
      _efforts = null;
      _effortsMessage = null;
    }
  }

  // --- actions on a card or a to-do: sent to the server that answered ------

  /// What the server said about the park message, as the end of a sentence.
  static String mcParkWords(McTodoResult r) {
    // Not told wins: a card moved again after a refusal must never read as "told".
    final why = r.refused;
    if (why != null) return ', but the session was not told: $why';
    if (r.uncertain) return '; the message may have reached the session';
    if (r.already) return '; its session was told before, so nothing was sent again';
    if (r.delivered) return '; the session was told to carry on';
    return '';
  }

  ApiClient _authority() {
    final sv = _servedBy;
    if (sv == null) throw const ApiException(0, 'Mission Control is not reachable right now');
    return client(sv);
  }

  /// Moves [card] to My to-do. Returns what to tell the person.
  Future<String> addTodo(McCard card, {String? text}) async {
    final r = await _authority().mcAddTodo(card.id, text: text);
    unawaited(refresh());
    return 'On your to-do list${mcParkWords(r)}';
  }

  /// #522: the person did action [card]: its session is told once. Returns what to tell the person.
  Future<String> actionDone(McCard card) async {
    final r = await _authority().mcActionDone(card.id);
    unawaited(refresh());
    final why = r.refused;
    if (why != null) return 'Not told yet: $why. Press Done again when it can be told';
    if (r.already) return 'Its session was already told';
    if (r.uncertain) return 'Marked done; the message may have reached the session';
    return 'Done - the session was told to carry on';
  }

  /// #547: [card]'s session is told the person answered its wait in another session. Returns what
  /// to tell the person; the card goes once the session has started on it.
  Future<String> tellAnswered(McCard card) async {
    final r = await _authority().mcTell(card.id);
    unawaited(refresh());
    final why = r.refused;
    if (why != null) return 'Not told yet: $why. Press Tell it again when it can be told';
    if (r.uncertain) return 'The message may have reached the session';
    return 'The session was told it was answered in "${card.answeredIn?.name ?? 'another session'}"';
  }

  /// Hides [card] for [hours].
  Future<String> later(McCard card, int hours) async {
    await _authority().mcLater(card.id, hours);
    unawaited(refresh());
    return hours == 1 ? 'Hidden for an hour' : 'Hidden for $hours hours';
  }

  /// `done`, `reopen`, `back` (to Answer now) or `park` (tell its session again after a
  /// refusal). Returns what to tell the person, or null when there is nothing to say.
  Future<String?> todoAction(McTodo todo, String action) async {
    final r = await _authority().mcTodoAction(todo.id, action);
    unawaited(refresh());
    return action == 'park' ? 'Asked again${mcParkWords(r)}' : null;
  }

  // --- subjects (#508, #509): read from the server that answered ------------

  /// The subjects of [project] (of [area] too, when given). Throws when Mission Control
  /// is not reachable; a 404 is a server without the subjects route yet.
  Future<McSubjects> subjects({String? project, String? area, String? line}) =>
      _authority().mcSubjects(project: project, area: area, line: line);

  /// #523 - the lines of work (of [project] when given) and the configured ones.
  Future<McLines> lines({String? project}) => _authority().mcLines(project: project);

  /// #523 - moves [subject] to line [line], to a new line [name], or (neither) back to the
  /// rules. Throws [ApiException] with the server's reason; the next Now answer follows.
  Future<McMoveResult> moveLine(String subject, {String? line, String? name}) async {
    final r = await _authority().mcMoveLine(subject, line: line, name: name);
    unawaited(refresh());
    return r;
  }

  /// One subject by [key]; a 404 is a key the server does not know (any more).
  Future<McSubjectDetail> subject(String key) => _authority().mcSubject(key);

  // --- Start work (#512): asked of the server that answered ---------------------

  /// The machines a session can be started on, with the one the server suggests.
  Future<McMachines> machines() => _authority().mcMachines();

  /// Starts a session bound to [project] and [subjects] (or a [hunt]) on [server]; the
  /// next answer shows it under its subject. Throws [ApiException] with the server's reason.
  Future<McStartResult> start({
    required String project,
    List<String> subjects = const [],
    bool hunt = false,
    required String server,
    String? brief,
    String? line,
    String? lineName,
  }) async {
    final r = await _authority()
        .mcStart(project: project, subjects: subjects, hunt: hunt, server: server, brief: brief, line: line, lineName: lineName);
    unawaited(refresh());
    return r;
  }

  /// The session [r] started, as this app opens it: on its own server (the one that
  /// answered when it runs on the authority, else the configured server at its url), with
  /// the agent and readiness the server resolved (#147), as every other create flow opens
  /// the session it just made. Null when its server is not in this app's list.
  Session? startedSession(McStartResult r) {
    final sv = r.serverUrl == null ? _servedBy : serverForUrl(servers(), r.serverUrl);
    if (sv == null) return null;
    return Session(
      id: r.sessionId,
      name: r.name ?? '',
      cwd: '',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: sv,
      agent: r.agent,
      agentReady: r.agentReady,
    );
  }

  /// Tells every session in [sessions] [text], each through the gated prompt on ITS OWN
  /// server (found by url in this app's list), one after the other. Never throws: each
  /// session gets its answer - told, refused with the server's reason, or why it could
  /// not be asked.
  Future<List<(McSubjectSession, McPromptResult)>> tell(List<McSubjectSession> sessions, String text) async {
    final list = servers();
    final out = <(McSubjectSession, McPromptResult)>[];
    for (final s in sessions) {
      final sv = serverForUrl(list, s.serverUrl);
      if (sv == null) {
        out.add((s, McPromptResult(error: "its server (${s.server ?? s.serverUrl ?? 'unknown'}) is not in this app's list")));
        continue;
      }
      try {
        out.add((s, await client(sv).promptSession(s.id, text)));
      } on ApiException catch (e) {
        out.add((s, McPromptResult(error: e.message)));
      } catch (e) {
        out.add((s, McPromptResult(error: '$e')));
      }
    }
    return out;
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _stopHurry();
    super.dispose();
  }
}
