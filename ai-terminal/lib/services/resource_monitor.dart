import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/models.dart';

/// Per-server CPU/memory for the dashboard (#152) — the box, web-terminal's own
/// footprint on it, and a reading per session.
///
/// **[enabled] gates levels 2/3 only — the box's own CPU/memory (level 1) is
/// free and is NOT behind it.** That was a known gap (#165): the machine
/// reading needs no per-process query, so gating it behind the same toggle as
/// the expensive levels was an accident of one widget reading one map, not a
/// cost decision. [_byBaseUrl]/[refresh] below is that expensive toggle —
/// **off by default, and polling only while it is on**, because each answer
/// costs the server a whole-machine process query (~370 ms of PowerShell) and
/// the dashboard talks to every configured server, so a monitor that polled
/// regardless would put a permanent process query on every box in the fleet
/// forever, for numbers nobody had asked to see. The session list is polled
/// continuously and deliberately does NOT carry these figures, for the same
/// reason. The free level-1 reading lives in a separate map
/// ([_machineByBaseUrl]/[machineFor]), published by [SessionRepository] from
/// the `/api/version` poll it already runs continuously — see
/// [publishMachine].
///
/// A server that fails or answers 404 (too old for the endpoint) is recorded as
/// unknown — never as zero. "Cannot measure" and "idle" must not look alike:
/// the second invites you to start work there, and this feature exists to make
/// that choice on evidence.
class ResourceMonitor extends ChangeNotifier {
  ResourceMonitor._();

  /// The process-wide monitor, mirroring [SessionRepository.instance]'s idiom.
  static final ResourceMonitor instance = ResourceMonitor._();

  /// How often each server is re-asked while the view is on. Slower than the
  /// session poll on purpose: this costs a process query and the numbers it
  /// reports are averages over a window, not events.
  static const Duration pollInterval = Duration(seconds: 6);

  static const String _prefsKey = 'resourceViewEnabled';

  bool _enabled = false;
  bool _loadedPref = false;

  /// Whether the app is in the foreground. A phone in a pocket must not keep
  /// asking three servers for a whole-machine process query every six seconds —
  /// the readings are for a screen someone is looking at, and there is no such
  /// screen while the app is paused. Mirrors [SessionRepository]'s own
  /// foreground gate, driven from the same lifecycle observer.
  bool _foreground = true;
  Timer? _timer;
  bool _inFlight = false;
  List<ServerConfig> _servers = const <ServerConfig>[];

  /// Bumped whenever the readings we are collecting stop being wanted — the view is
  /// switched off, or the app goes to the background. A refresh captures it before its
  /// first await and abandons its results if it changed, so an answer that arrives after
  /// the map was deliberately emptied cannot quietly refill it.
  int _generation = 0;

  /// Test seam: supplies the HTTP client each poll uses, so a test can hold a request
  /// open and drive the toggle underneath it. Null in production.
  @visibleForTesting
  http.Client Function()? httpClientFactory;

  final Map<String, ServerResources?> _byBaseUrl = <String, ServerResources?>{};

  /// The FREE per-server machine reading (#152 level 1, #165) — kept apart
  /// from [_byBaseUrl], which only the expensive `/api/resources` poll
  /// writes. [SessionRepository] publishes here from every `/api/version`
  /// poll it already makes (see `_ensureServerNames`), independent of
  /// [enabled]: unlike [refresh] below, this never starts a whole-machine
  /// process query, so there is nothing for the toggle to gate. A baseUrl
  /// absent from this map has never been asked; one present with a `null`
  /// value was asked and got nothing usable (offline, or too old for the
  /// field) — [ServerResourceLine] renders those two states differently, the
  /// same "absent vs. null" idiom [ServerResources.sessions] already uses.
  final Map<String, MachineResources?> _machineByBaseUrl =
      <String, MachineResources?>{};

  bool get enabled => _enabled;

  /// The last reading for [baseUrl], or `null` when unknown.
  ServerResources? operator [](String baseUrl) => _byBaseUrl[baseUrl];

  /// The free machine reading for [baseUrl], or `null` if none has arrived
  /// (never asked, or asked and got nothing usable).
  MachineResources? machineFor(String baseUrl) => _machineByBaseUrl[baseUrl];

  /// Whether [baseUrl] has ever answered on the free channel — the "never
  /// asked" / "asked, got null" distinction [machineFor] alone cannot make.
  bool hasMachine(String baseUrl) => _machineByBaseUrl.containsKey(baseUrl);

  /// Publishes a fresh free-channel machine reading for [baseUrl]. Called by
  /// [SessionRepository] after each `/api/version` poll, success or
  /// failure (`null` on failure) — never gated on [enabled], and never
  /// mixed into [_byBaseUrl], which stays the expensive poll's alone.
  void publishMachine(String baseUrl, MachineResources? machine) {
    _machineByBaseUrl[baseUrl] = machine;
    notifyListeners();
  }

  /// The reading for one session, or `null` when unknown. Callers must render
  /// `null` as a dash, never as `0`.
  ResourceReading? reading(String baseUrl, String sessionId) {
    final report = _byBaseUrl[baseUrl];
    if (report == null || !report.samplingOk) return null;
    return report.forSession(sessionId);
  }

  /// Restore the remembered choice. Safe to call more than once; only the first
  /// call reads storage, so a rebuild cannot restart the loop behind the user.
  Future<void> restore(List<ServerConfig> servers) async {
    _servers = servers;
    if (_loadedPref) return;
    _loadedPref = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      _enabled = prefs.getBool(_prefsKey) ?? false;
    } catch (_) {
      _enabled = false;
    }
    if (_enabled) {
      notifyListeners();
      _start();
    }
  }

  /// Keep the server list current — the dashboard's cluster discovery can add
  /// one after the view is already running.
  void updateServers(List<ServerConfig> servers) {
    _servers = servers;
  }

  Future<void> setEnabled(bool value) async {
    if (_enabled == value) return;
    _enabled = value;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefsKey, value);
    } catch (_) {
      // A preference that could not be saved is not a reason to refuse the
      // toggle — the view still works for this run.
    }
    _generation++;
    if (value) {
      _start();
    } else {
      _stop();
      // Drop what we hold rather than leaving it on screen: a frozen reading
      // ages silently into a confident lie.
      _byBaseUrl.clear();
    }
    notifyListeners();
  }

  /// Resume polling after the app comes back to the foreground.
  void startForeground() {
    _foreground = true;
    if (_enabled) _start();
  }

  /// Stop polling while the app is backgrounded. [enabled] is untouched, so the
  /// view is still on when the user returns — it simply costs nothing meanwhile.
  ///
  /// The readings are dropped as well. A phone comes back out of a pocket an hour
  /// later, and rendering the numbers from before it went in would be the same
  /// confident lie a frozen reading always is — with nothing on screen to reveal
  /// the age. [startForeground] refreshes immediately, so the gap is one round trip.
  ///
  /// [_machineByBaseUrl] is deliberately left alone. It is not this class's poll
  /// that fills it — [SessionRepository] does, on its own foreground/background
  /// lifecycle — and that repo already treats a stale session LIST as fine to
  /// paint instantly from cache while a live refresh catches up behind it
  /// (`primeFromCache`). The machine reading is the same kind of number: cheap,
  /// low-stakes, refreshed within moments of resume. Blanking it here would just
  /// flash "—" for one frame before the real value reappears.
  void stopForeground() {
    _foreground = false;
    _generation++;
    _stop();
    _byBaseUrl.clear();
    notifyListeners();
  }

  void _start() {
    _timer?.cancel();
    _timer = null;
    if (!_foreground) return;
    unawaited(refresh());
    _timer = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// Ask every configured server once. Overlapping calls are dropped rather
  /// than queued — a slow server must not stack up requests behind itself.
  Future<void> refresh() async {
    if (!_enabled || _inFlight) return;
    // Captured BEFORE the first await: everything below is answered by servers over the
    // network, and the user can switch the view off in the middle of it.
    final gen = _generation;
    _inFlight = true;
    try {
      await Future.wait(_servers.map((server) async {
        // A server too old for the endpoint is simply re-asked each poll. That
        // costs a 404 round trip and nothing else — the process query it would
        // have run does not exist there — and it means upgrading a server is
        // picked up on the next tick instead of needing an app restart.
        //
        // The try/catch is not belt-and-braces: `Future.wait` fails the WHOLE
        // wait on the first error, discarding every other server's answer and
        // skipping the notify. ApiClient.resources() swallows everything today,
        // so this loop is one narrowed catch over there away from a fleet-wide
        // readout that goes blank because a single box is unreachable.
        ServerResources? report;
        try {
          report = await ApiClient(server, httpClient: httpClientFactory?.call())
              .resources();
        } catch (_) {
          report = null;
        }
        // Nobody is waiting for this any more — the view was switched off, or the app
        // was backgrounded, and the map was emptied on purpose. Writing here would
        // refill it invisibly (no notify fires while disabled), and the numbers would
        // reappear as if current the moment the view came back on.
        if (gen != _generation) return;
        // A null is "unknown", explicitly. Overwriting rather than keeping the
        // previous reading is deliberate: stale numbers here are worse than none.
        _byBaseUrl[server.baseUrl] = report;
      }));
    } finally {
      _inFlight = false;
    }
    if (_enabled && gen == _generation) notifyListeners();
  }

  /// Test seam — forget everything, including the restored preference.
  @visibleForTesting
  void resetForTests() {
    _stop();
    _enabled = false;
    _loadedPref = false;
    _inFlight = false;
    _servers = const <ServerConfig>[];
    _foreground = true;
    _generation++;
    httpClientFactory = null;
    _byBaseUrl.clear();
    _machineByBaseUrl.clear();
  }

  /// Test seam — install a reading without going near the network.
  @visibleForTesting
  void seedForTests(String baseUrl, ServerResources? report, {bool enable = true}) {
    _enabled = enable;
    _loadedPref = true;
    _byBaseUrl[baseUrl] = report;
    notifyListeners();
  }

  // No `dispose()` override, deliberately. This is a process-wide singleton with the
  // lifetime of the app: disposing a ChangeNotifier makes every later
  // notifyListeners() assert, so one widget calling it in its own dispose() would
  // kill the readout for the rest of the run. The timer is stopped by
  // stopForeground()/setEnabled(false), which is what actually happens.
}
