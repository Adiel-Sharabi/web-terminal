// The sessions dashboard (#306): what every session on every server is working on,
// in one view — the companion's copy of `app.html`'s ▦ overlay (#298).
//
// Every rule behind a card is SERVER-side: which work items show and when a report
// is stale (`lib/session-brief.js`), and WHY a session that is not working is not
// working (`lib/session-reason.js`, #313). This screen only lays the answers out, so
// the web app and the companion cannot disagree about a card. The session rows come
// from [SessionRepository], which already merges every server client-side; this
// screen adds a faster poll while it is open, and each server's "closed in the last
// day" list.
//
// #314 adds what makes it something to work FROM: Favorites first (moved, not
// repeated) and an Active / Hidden split (hidden is stored on the session's server,
// so every device agrees). #315 gives every card its machine's colour as a stripe.
//
// #337 kept only what is used: the board is always grouped by reason, in the
// session list's own order. The grouping switch, the order menu, the text and
// machine filters and the summary chips are gone. On a wide window the board is
// shown beside the session list ([WorkBoardScreen.embedded]), not over it.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/app_config.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../widgets/format_utils.dart';
import '../widgets/reason_chip.dart';
import '../widgets/server_badge.dart';
import '../widgets/status_dot.dart';

/// A session's status as the board shows it: a label and a colour.
class BoardStatus {
  final String label;
  final Color color;
  final SessionStatus dot;
  const BoardStatus(this.label, this.color, this.dot);
}

/// The board's reading of a session's status. A capped session is shown as capped
/// whatever its raw status, because "sitting out its 5h window" is the answer to
/// "why is nothing happening"; a blocked one names what it owes you.
BoardStatus boardStatusOf(Session s) {
  final cap = s.usageLimit;
  if (cap != null && cap.waiting) {
    final at = cap.resumeAt;
    final label = (cap.armed && at != null) ? 'Capped · resumes ${_hhmm(at)}' : 'Capped';
    return BoardStatus(label, StatusColor.capped, SessionStatus.idle);
  }
  final st = sessionStatusFromString(s.status);
  return switch (st) {
    SessionStatus.waiting => BoardStatus(
        s.waitingFor == 'question' ? 'Question for you' : 'Needs you', StatusColor.waiting, st),
    SessionStatus.working => const BoardStatus('Working', StatusColor.working, SessionStatus.working),
    SessionStatus.active => const BoardStatus('Active', StatusColor.active, SessionStatus.active),
    SessionStatus.apiError => const BoardStatus('API error', StatusColor.apiError, SessionStatus.apiError),
    SessionStatus.idle => const BoardStatus('Idle', StatusColor.idle, SessionStatus.idle),
  };
}

String _hhmm(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

/// `ready-for-test` -> `ready for test`.
String briefStateLabel(String state) => state.replaceAll('-', ' ');

/// The pill colours for a work-item state; matches `app.html`'s `.db-state.s-*`.
({Color bg, Color fg}) briefStateColors(String? state) => switch (state) {
      'planning' => (bg: const Color(0xFF2A2540), fg: const Color(0xFFC9BCFF)),
      'in-progress' => (bg: const Color(0xFF3A2A12), fg: const Color(0xFFFFB454)),
      'blocked' => (bg: const Color(0xFF3A1D26), fg: const Color(0xFFFF9AAC)),
      'ready-for-test' => (bg: const Color(0xFF123A33), fg: const Color(0xFF5FE8C9)),
      'committed' => (bg: const Color(0xFF1B2B3D), fg: const Color(0xFF9CC6F0)),
      'done' => (bg: const Color(0xFF1D3320), fg: const Color(0xFF8FD59A)),
      _ => (bg: const Color(0xFF2A303C), fg: const Color(0xFFC3C9D4)),
    };

/// Why a card shows no work item.
String noItemReason(Session s) {
  final b = s.brief;
  if (b == null) return s.agent == 'claude' ? 'Nothing reported yet' : 'Not reporting';
  return b.reportingOn ? 'No work item' : 'Reporting is off for this session';
}

/// Owes the person something: a live prompt, or the agent said it is their move.
/// A panel over the composer (#316) owes the person an Esc as much as a prompt owes an
/// answer, so it is "needs you" too.
bool boardNeedsYou(Session s) =>
    s.status == 'waiting' || s.reason?.kind == 'you' || s.reason?.kind == 'menu';

/// Hidden from the dashboard (#314).
bool boardIsHidden(Session s) => s.brief?.hidden == true;

/// The reason-grouping sections, in display order.
enum ReasonSection { needsYou, working, self, external, idle, notReported, done }

/// Which reason section [s] belongs in.
ReasonSection reasonSectionOf(Session s) {
  if (boardNeedsYou(s)) return ReasonSection.needsYou;
  switch (s.reason?.kind) {
    case 'working':
      return ReasonSection.working;
    case 'self':
      return ReasonSection.self;
    case 'external':
      return ReasonSection.external;
    case 'done':
      return ReasonSection.done;
  }
  // A peer too old to send `reason` still has a status: a turn it is running is
  // "Working", never "Idle" (#313 review).
  if (s.reason == null && s.status == 'working') return ReasonSection.working;
  final b = s.brief;
  final reported = b != null && (b.items.isNotEmpty || b.headline != null);
  return reported ? ReasonSection.idle : ReasonSection.notReported;
}

/// The sessions dashboard. [onOpenSession] is called when a card is tapped; the
/// caller decides how to show it (split pane or a pushed route).
class WorkBoardScreen extends StatefulWidget {
  const WorkBoardScreen({
    super.key,
    required this.onOpenSession,
    this.embedded = false,
    this.repository,
    this.servers,
    this.clientFactory,
    this.pollInterval = const Duration(seconds: 5),
  });

  final void Function(Session session) onOpenSession;

  /// True when shown inline as the detail pane of the wide split view (#337), not
  /// pushed as its own route. Suppresses the AppBar back button, as
  /// `SessionScreen.embedded` does.
  final bool embedded;

  /// Injectable for tests; defaults to [SessionRepository.instance].
  final SessionRepository? repository;

  /// Injectable for tests; defaults to [AppConfig.servers].
  final List<ServerConfig> Function()? servers;

  /// Injectable for tests; defaults to `ApiClient.new`.
  final ApiClient Function(ServerConfig server)? clientFactory;

  /// How often the board re-asks every server while it is open. The repository's
  /// own 30s timer is too slow for a screen whose whole job is "now".
  final Duration pollInterval;

  @override
  State<WorkBoardScreen> createState() => _WorkBoardScreenState();
}

class _WorkBoardScreenState extends State<WorkBoardScreen> {
  static const _closedEvery = Duration(seconds: 30);
  static const _machineEvery = Duration(seconds: 30);
  static const _prefsKey = 'wt.dashboard.view';

  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  StreamSubscription<List<Session>>? _sub;
  Timer? _poll;
  List<Session> _sessions = const [];
  final Map<String, ({DateTime at, List<ClosedSession> list})> _closed = {};
  bool _showHidden = false;
  bool _doneOpen = false;

  // #331 - the Machines section. Asked only while it is OPEN: each answer costs its
  // server a CIM query. `failed` keeps "could not read" apart from "not asked yet".
  bool _machinesOpen = false;
  final Map<String, ({DateTime at, MachineProfile? data, bool failed})> _machines = {};

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  Color? _colorOf(String baseUrl) => colorFromHex(_repo.serverColor(baseUrl));

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    unawaited(_loadPrefs());
    _sub = _repo.sessions.listen((list) {
      if (!mounted) return;
      setState(() => _sessions = list);
      unawaited(_refreshClosed());
      unawaited(_refreshMachines());
    });
    // Only while the app is in the foreground: `main.dart` stops the repository's own
    // polling when the app is backgrounded, and this faster tick must not undo that.
    _poll = Timer.periodic(widget.pollInterval, (_) {
      if (_repo.isForeground) unawaited(_repo.refresh());
    });
    unawaited(_repo.refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  // Whether Machines is open is per DEVICE (a phone and a desk can want different
  // views); what a session IS (hidden, favourite) lives on its server. A grouping or
  // order an older build saved under the same key is simply ignored (#337).
  Future<void> _loadPrefs() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      if (raw == null) return;
      final m = jsonDecode(raw);
      if (m is! Map || !mounted) return;
      if (m['machines'] is bool) setState(() => _machinesOpen = m['machines'] as bool);
      unawaited(_refreshMachines());
    } catch (_) {/* defaults */}
  }

  Future<void> _savePrefs() async {
    try {
      await (await SharedPreferences.getInstance()).setString(_prefsKey, jsonEncode({'machines': _machinesOpen}));
    } catch (_) {/* a preference that cannot be saved is not a reason to refuse the change */}
  }

  Future<void> _refreshClosed() async {
    final servers = _servers;
    // A server removed from the list takes its history with it.
    _closed.removeWhere((url, _) => !servers.any((sv) => sv.baseUrl == url));
    final due = servers.where((sv) {
      if (!_repo.supportsBrief(sv.baseUrl)) return false;
      // Not worth a request that cannot succeed; its last list stays until it is back.
      if (_repo.serverUsable[sv.baseUrl] != true) return false;
      final hit = _closed[sv.baseUrl];
      return hit == null || DateTime.now().difference(hit.at) > _closedEvery;
    }).toList();
    if (due.isEmpty) return;
    // Stamp first, so a slow server is not asked again by the next emit.
    for (final sv in due) {
      _closed[sv.baseUrl] = (at: DateTime.now(), list: _closed[sv.baseUrl]?.list ?? const []);
    }
    await Future.wait(due.map((sv) async {
      try {
        final list = await _client(sv).dashboardClosed();
        _closed[sv.baseUrl] = (at: DateTime.now(), list: list);
      } catch (_) {
        // Best effort: the strip is history, and the live cards are unaffected.
      }
    }));
    if (mounted) setState(() {});
  }

  Future<void> _refreshMachines({bool force = false}) async {
    if (!_machinesOpen) return;
    final servers = _servers;
    _machines.removeWhere((url, _) => !servers.any((sv) => sv.baseUrl == url));
    final due = servers.where((sv) {
      if (!_repo.supportsMachine(sv.baseUrl) || _repo.serverUsable[sv.baseUrl] != true) return false;
      final hit = _machines[sv.baseUrl];
      return force || hit == null || DateTime.now().difference(hit.at) > _machineEvery;
    }).toList();
    if (due.isEmpty) return;
    // Stamp first, so a slow server is not asked again by the next emit.
    for (final sv in due) {
      final hit = _machines[sv.baseUrl];
      _machines[sv.baseUrl] = (at: DateTime.now(), data: hit?.data, failed: hit?.failed ?? false);
    }
    await Future.wait(due.map((sv) async {
      final p = await _client(sv).machine();
      // Unknown, not the previous reading: an old number would age into a confident lie.
      _machines[sv.baseUrl] = (at: DateTime.now(), data: p, failed: p == null);
    }));
    if (mounted) setState(() {});
  }

  void _toggleMachines() {
    setState(() => _machinesOpen = !_machinesOpen);
    unawaited(_savePrefs());
    unawaited(_refreshMachines(force: true));
  }

  /// What a machine card says instead of readings, or null when it has some.
  String? _machineNote(ServerConfig sv) {
    if (_repo.serverNeedsAuth[sv.baseUrl] == true) return 'needs login';
    if (_repo.serverOfflineConfirmed[sv.baseUrl] == true) return 'offline';
    // Its capabilities are not known until a version call has answered.
    if (_repo.serverVersion(sv.baseUrl) == null) return 'reading…';
    if (!_repo.supportsMachine(sv.baseUrl)) return 'this server is too old to report its machine';
    final hit = _machines[sv.baseUrl];
    if (hit?.data != null) return null;
    return hit?.failed == true ? 'could not read it' : 'reading…';
  }

  void _say(String text, {SnackBarAction? action}) {
    // An Undo outlives the screen (the snackbar is the root messenger's), so its
    // failure can land here after the board was closed.
    if (!mounted) return;
    final m = ScaffoldMessenger.maybeOf(context);
    m?.hideCurrentSnackBar();
    // #322 - `persist` is load-bearing: the SDK defaults a snackbar WITH an action (our
    // Undo) to persist, ignoring `duration`, so the toast never left the screen. It must
    // still persist under TalkBack/VoiceOver, where the user needs time to reach Undo -
    // the protection that default exists for.
    m?.showSnackBar(SnackBar(
        content: Text(text),
        action: action,
        duration: const Duration(seconds: 5),
        persist: MediaQuery.accessibleNavigationOf(context)));
  }

  Future<bool> _patch(Session s,
      {List<Map<String, dynamic>>? pinned, bool? optOut, bool? hidden, bool clearWait = false}) async {
    var ok = true;
    try {
      await _client(s.server).patchBrief(s.id, pinned: pinned, optOut: optOut, hidden: hidden, clearWait: clearWait);
    } catch (e) {
      // A snackbar rather than a banner: it says what failed and then goes away,
      // instead of sitting on the board until some later save happens to succeed.
      _say('Could not save: ${e is ApiException ? e.message : '$e'}');
      ok = false;
    }
    await _repo.refresh();
    return ok;
  }

  Future<bool> _setFavorite(Session s, bool favorite) async {
    try {
      await _client(s.server).setFavorite(s.id, favorite);
      return true;
    } catch (e) {
      _say('Could not save: ${e is ApiException ? e.message : '$e'}');
      return false;
    }
  }

  Future<void> _pin(Session s) async {
    final item = await showDialog<BriefItem>(context: context, builder: (_) => const _PinDialog());
    if (item == null) return;
    final kept = (s.brief?.items ?? const <BriefItem>[])
        .where((i) => i.pinned && i.ref != item.ref)
        .map((i) => i.toPinJson());
    await _patch(s, pinned: [...kept, item.toPinJson()]);
  }

  Future<void> _unpin(Session s, BriefItem item) =>
      _patch(s, pinned: (s.brief?.pinnedForPatch ?? const []).where((p) => p['ref'] != item.ref).toList());

  Future<void> _toggleReporting(Session s) => _patch(s, optOut: s.brief?.reportingOn ?? true);

  // Hiding is cheap and fully reversible, so it asks nothing and offers an undo. A
  // favourite is unstarred first: "starred" and "hidden" would contradict each other.
  Future<void> _setHidden(Session s, bool hidden) async {
    final wasFav = s.favorite;
    if (hidden && wasFav && !await _setFavorite(s, false)) return;
    if (!await _patch(s, hidden: hidden)) return;
    if (!mounted) return;
    _say('${hidden ? 'Hidden' : 'Unhid'} "${s.name}"',
        action: SnackBarAction(
          label: 'Undo',
          onPressed: () async {
            await _patch(s, hidden: !hidden);
            if (hidden && wasFav) {
              await _setFavorite(s, true);
              await _repo.refresh();
            }
          },
        ));
  }

  Future<void> _toggleStar(Session s) async {
    if (await _setFavorite(s, !s.favorite)) await _repo.refresh();
  }

  BoardActions _actionsFor(Session s) {
    final base = s.server.baseUrl;
    final brief = _repo.supportsBrief(base);
    return BoardActions(
      onOpen: () => widget.onOpenSession(s),
      onPin: brief ? () => _pin(s) : null,
      onUnpin: brief ? (it) => _unpin(s, it) : null,
      // Only a session with a brief can stop or resume: one that never reported has
      // nothing to switch, and the item would mean nothing.
      onToggleReporting: (brief && s.brief != null) ? () => _toggleReporting(s) : null,
      onHide: _repo.supportsHide(base) ? () => _setHidden(s, !boardIsHidden(s)) : null,
      // #320 - only a REPORTED reason is the person's to clear.
      onClearWait: _repo.canClearWait(s) ? () => _patch(s, clearWait: true) : null,
      onStar: _repo.supportsFavorites(base) ? () => _toggleStar(s) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final all = _sessions;
    final servers = _servers;
    final hidden = all.where(boardIsHidden).toList();
    final shown = all.where((s) => !boardIsHidden(s)).toList();
    final closed = _closed.values.expand((v) => v.list).toList()
      ..sort((a, b) => (b.at ?? 0).compareTo(a.at ?? 0));

    // Needs you is always complete, a hidden session included. The visible ones ARE
    // the board's first section, so only hidden ones ride the strip.
    final strip = hidden.where(boardNeedsYou).toList();

    final children = <Widget>[
      if (!_showHidden && strip.isNotEmpty)
        _NeedsYou(sessions: strip, onOpen: widget.onOpenSession, onClearWaitOf: (s) => _actionsFor(s).onClearWait),
      if (!_showHidden && servers.isNotEmpty)
        _Section(
          key: const ValueKey('board-machines'),
          title: 'Machines',
          collapsed: !_machinesOpen,
          onToggle: _toggleMachines,
          trailing: [
            Text('disk, memory and load: where to open a new session',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant)),
          ],
          children: [
            for (final sv in servers)
              MachineCard(
                key: ValueKey('board-machine-${sv.baseUrl}'),
                name: sv.name,
                color: _colorOf(sv.baseUrl),
                note: _machineNote(sv),
                profile: _machines[sv.baseUrl]?.data,
              ),
          ],
        ),
    ];

    if (_showHidden) {
      children.add(hidden.isEmpty
          ? const _Empty('Nothing is hidden. Hide a session from its ⋮ menu.')
          : _Section(title: 'Hidden', rows: true, children: [
              for (final s in hidden)
                BoardRow(key: _key(s), session: s, color: _colorOf(s.server.baseUrl), actions: _actionsFor(s), unhide: true),
            ]));
    } else if (all.isEmpty) {
      children.add(const _Empty('No sessions on any server.'));
    } else if (shown.isEmpty) {
      children.add(const _Empty('Every session is hidden. They are on the Hidden tab.'));
    } else {
      // Favourites first, and MOVED there rather than repeated below: a card is tall,
      // and a duplicate doubles the scroll and makes every count ambiguous. They keep
      // the session list's pinned order: that order is the owner's.
      final favs = Session.pinnedOrder(shown);
      final rest = shown.where((s) => !s.favorite).toList();
      if (favs.isNotEmpty) {
        children.add(_Section(
          key: const ValueKey('board-favorites'),
          title: '★ Favorites',
          trailing: [_countText(favs.length)],
          children: [for (final s in favs) _card(s)],
        ));
      }
      children.addAll(_reasonSections(rest));
    }
    if (!_showHidden && closed.isNotEmpty) children.add(_ClosedStrip(closed: closed, colorOf: _colorOf));
    children.add(const SizedBox(height: 24));

    return Scaffold(
      appBar: AppBar(
        // Beside the session list there is nothing to go back to (#337).
        automaticallyImplyLeading: !widget.embedded,
        title: const Text('Dashboard'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: SegmentedButton<bool>(
                key: const ValueKey('board-tabs'),
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(value: false, label: Text('Active ${shown.length}')),
                  ButtonSegment(
                    value: true,
                    label: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text('Hidden ${hidden.length}'),
                      // A hidden session that owes an answer flags its tab, so hiding
                      // never buries one.
                      if (hidden.any(boardNeedsYou))
                        Container(
                          margin: const EdgeInsets.only(left: 5),
                          width: 6,
                          height: 6,
                          decoration: const BoxDecoration(color: StatusColor.waiting, shape: BoxShape.circle),
                        ),
                    ]),
                  ),
                ],
                selected: {_showHidden},
                onSelectionChanged: (v) => setState(() => _showHidden = v.first),
              ),
            ),
          ),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _repo.refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: children,
        ),
      ),
    );
  }

  Key _key(Session s) => ValueKey('board-${s.server.baseUrl}-${s.id}');

  Widget _card(Session s) => BoardCard(
        key: _key(s),
        session: s,
        color: _colorOf(s.server.baseUrl),
        actions: _actionsFor(s),
      );

  Widget _row(Session s) => BoardRow(key: _key(s), session: s, color: _colorOf(s.server.baseUrl), actions: _actionsFor(s));

  List<Widget> _reasonSections(List<Session> rest) {
    List<Session> of(ReasonSection sec) => rest.where((s) => reasonSectionOf(s) == sec).toList();
    Widget? cards(String title, ReasonSection sec, {Key? key}) {
      final list = of(sec);
      if (list.isEmpty) return null;
      return _Section(key: key, title: title, trailing: [_countText(list.length)], children: [for (final s in list) _card(s)]);
    }

    final notReported = of(ReasonSection.notReported);
    final done = of(ReasonSection.done);
    return [
      ?cards('Needs you', ReasonSection.needsYou, key: const ValueKey('board-sec-you')),
      ?cards('Working', ReasonSection.working),
      ?cards('Running on its own', ReasonSection.self),
      ?cards('Blocked on others', ReasonSection.external),
      ?cards('Idle', ReasonSection.idle),
      if (notReported.isNotEmpty)
        _Section(title: 'Not reported', rows: true, trailing: [_countText(notReported.length)], children: [
          for (final s in notReported) _row(s),
        ]),
      if (done.isNotEmpty)
        _Section(
          key: const ValueKey('board-sec-done'),
          title: 'Done',
          rows: true,
          collapsed: !_doneOpen,
          onToggle: () => setState(() => _doneOpen = !_doneOpen),
          trailing: [_countText(done.length)],
          children: [for (final s in done) _row(s)],
        ),
    ];
  }

  Widget _countText(int n) => Text('$n session${n == 1 ? '' : 's'}',
      style: const TextStyle(color: AppColors.onSurfaceVariant, fontSize: 12));
}

/// What a card or row can do, already bound to its session. A null action means the
/// session's server cannot take it (too old), so the control is not offered at all.
class BoardActions {
  final VoidCallback onOpen;
  final VoidCallback? onPin;
  final void Function(BriefItem item)? onUnpin;
  final VoidCallback? onToggleReporting;
  final VoidCallback? onHide;
  final VoidCallback? onStar;
  final VoidCallback? onClearWait;
  const BoardActions({
    required this.onOpen,
    this.onPin,
    this.onUnpin,
    this.onToggleReporting,
    this.onHide,
    this.onStar,
    this.onClearWait,
  });
}

class _NeedsYou extends StatelessWidget {
  const _NeedsYou({required this.sessions, required this.onOpen, required this.onClearWaitOf});
  final List<Session> sessions;
  final void Function(Session) onOpen;

  /// #324 - the same rule as the card menu's "Not waiting" (`_actionsFor`): a hidden
  /// session has no card on this tab, so the strip is the only place to clear it.
  final VoidCallback? Function(Session) onClearWaitOf;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('board-needs-you'),
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: StatusColor.waiting.withValues(alpha: 0.08),
        border: Border.all(color: StatusColor.waiting.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(AppShape.medium),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const Text('Needs you', style: TextStyle(fontWeight: FontWeight.w700, color: StatusColor.waiting)),
          for (final s in sessions)
            InputChip(
              key: ValueKey('board-needs-${s.server.baseUrl}-${s.id}'),
              avatar: const StatusDot(status: SessionStatus.waiting, size: 8),
              // "hidden" before the long reason, so a phone's truncation cannot eat it.
              label: Text('${s.name}${boardIsHidden(s) ? ' · hidden' : ''} · ${s.server.name} · '
                  '${s.reason?.kind == 'menu' ? 'stuck in a menu (Esc)' : s.reason?.kind == 'you' && s.reason!.text.isNotEmpty ? s.reason!.text : s.waitingFor == 'question' ? 'a question' : 'a permission'}'),
              onPressed: () => onOpen(s),
              onDeleted: onClearWaitOf(s),
              deleteButtonTooltipMessage: 'Not waiting: ${s.name}',
            ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);
  final String text;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(text, textAlign: TextAlign.center)));
}

class _Section extends StatelessWidget {
  const _Section({
    super.key,
    required this.title,
    required this.children,
    this.trailing = const [],
    this.rows = false,
    this.collapsed = false,
    this.onToggle,
  });
  final String title;
  final List<Widget> trailing;
  final List<Widget> children;

  /// One-line rows in a column rather than cards in a grid.
  final bool rows;
  final bool collapsed;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final head = Wrap(
      spacing: 10,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (onToggle != null) Icon(collapsed ? Icons.chevron_right : Icons.expand_more, size: 18),
          Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
        ]),
        ...trailing,
      ],
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: onToggle == null ? head : InkWell(onTap: onToggle, child: head),
          ),
          if (!collapsed)
            if (rows)
              Column(children: [
                for (final r in children) Padding(padding: const EdgeInsets.only(bottom: 4), child: r),
              ])
            else
              // A grid on a wide window, one column on a phone.
              LayoutBuilder(builder: (context, c) {
                const gap = 10.0;
                final cols = (c.maxWidth / 340).floor().clamp(1, 6);
                final w = (c.maxWidth - gap * (cols - 1)) / cols;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: [for (final card in children) SizedBox(width: w, child: card)],
                );
              }),
        ],
      ),
    );
  }
}

class _StatePill extends StatelessWidget {
  const _StatePill(this.state);
  final String state;

  @override
  Widget build(BuildContext context) {
    final c = briefStateColors(state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(color: c.bg, borderRadius: BorderRadius.circular(999)),
      child: Text(briefStateLabel(state),
          style: TextStyle(color: c.fg, fontSize: 10, fontWeight: FontWeight.w600)),
    );
  }
}

/// The machine stripe (#315): 3px of the machine's colour down the left edge. Nothing
/// else on the board uses a left stripe, so it can only ever mean "which machine".
class _Striped extends StatelessWidget {
  const _Striped({required this.color, required this.child});
  final Color? color;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    if (color == null) return child;
    return Stack(children: [
      child,
      Positioned(left: 0, top: 0, bottom: 0, width: 3, child: ColoredBox(color: color!)),
    ]);
  }
}

/// The status word, or the reason that replaces it (#313).
Widget _statusOrReason(Session s) {
  if (hasReasonChip(s.reason)) return ReasonChip(reason: s.reason!);
  final st = boardStatusOf(s);
  return Text(st.label, style: TextStyle(color: st.color, fontSize: 12, fontWeight: FontWeight.w600));
}

/// The ⋮ menu shared by cards and rows: hide or unhide, star, stop reporting.
Widget? _moreMenu(Session s, BoardActions a, {bool includePin = false}) {
  final items = <PopupMenuEntry<String>>[
    if (includePin && a.onPin != null) const PopupMenuItem(value: 'pin', child: Text('Pin work item')),
    if (a.onHide != null)
      PopupMenuItem(
        value: 'hide',
        child: Text(boardIsHidden(s) ? 'Unhide' : (s.favorite ? 'Unstar & hide' : 'Hide from dashboard')),
      ),
    if (a.onStar != null) PopupMenuItem(value: 'star', child: Text(s.favorite ? 'Unstar' : 'Star')),
    if (a.onClearWait != null) const PopupMenuItem(value: 'clear-wait', child: Text('Not waiting')),
    if (a.onToggleReporting != null)
      PopupMenuItem(value: 'report', child: Text(s.brief?.reportingOn == false ? 'Resume reporting' : 'Stop reporting')),
  ];
  if (items.isEmpty) return null;
  return PopupMenuButton<String>(
    key: ValueKey('board-more-${s.server.baseUrl}-${s.id}'),
    tooltip: 'More actions',
    icon: const Icon(Icons.more_vert, size: 18),
    padding: EdgeInsets.zero,
    itemBuilder: (_) => items,
    onSelected: (v) => switch (v) {
      'pin' => a.onPin?.call(),
      'hide' => a.onHide?.call(),
      'star' => a.onStar?.call(),
      'report' => a.onToggleReporting?.call(),
      'clear-wait' => a.onClearWait?.call(),
      _ => null,
    },
  );
}

/// One session's card on the dashboard.
class BoardCard extends StatelessWidget {
  const BoardCard({super.key, required this.session, required this.actions, this.color});

  final Session session;
  final BoardActions actions;

  /// The session's machine colour (#315), or null when its server has not said.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = session;
    final b = s.brief;
    final st = boardStatusOf(s);
    final items = b?.items ?? const <BriefItem>[];
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    final more = _moreMenu(s, actions);

    final lines = <(String, BriefLine)>[
      if (b?.now != null && s.status == 'working') ('Now', b!.now!),
      if (b?.did != null) ('Did', b!.did!),
      if (b?.prompt != null) ('You', b!.prompt!),
    ];

    return Opacity(
      opacity: s.reason?.kind == 'done' ? 0.55 : 1,
      child: Material(
        color: AppColors.surfaceContainer,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.large),
          side: BorderSide(color: boardNeedsYou(s) ? StatusColor.waiting : AppColors.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: _Striped(
          color: color,
          child: InkWell(
            onTap: actions.onOpen,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 12, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    StatusDot(status: st.dot, size: 9),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(s.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    ),
                    const SizedBox(width: 8),
                    Flexible(child: Align(alignment: Alignment.centerRight, child: _statusOrReason(s))),
                  ]),
                  const SizedBox(height: 8),
                  if (items.isEmpty)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      decoration: BoxDecoration(
                        border: Border.all(color: AppColors.outlineVariant),
                        borderRadius: BorderRadius.circular(AppShape.small),
                      ),
                      child: Text(noItemReason(s), style: muted),
                    )
                  else
                    for (final it in items) _itemRow(context, it),
                  if (b?.headline != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(b!.headline!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                    ),
                  if (lines.isNotEmpty) const SizedBox(height: 6),
                  for (final (label, line) in lines)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        SizedBox(width: 34, child: Text(label, style: muted)),
                        Expanded(
                          child: Tooltip(
                            message: line.text,
                            child: Text(line.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                          ),
                        ),
                        if (line.at != null) ...[
                          const SizedBox(width: 6),
                          Text(relativeTime(line.at), style: muted?.copyWith(fontSize: 10)),
                        ],
                      ]),
                    ),
                  if (b != null && b.artifacts.isNotEmpty)
                    Padding(padding: const EdgeInsets.only(top: 6), child: ArtifactLinks(b.artifacts)),
                  if (b?.staleReason != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text('⚠ Report may be out of date: ${b!.staleReason}',
                          key: const ValueKey('board-stale'),
                          style: const TextStyle(color: AppColors.caution, fontSize: 12)),
                    ),
                  const SizedBox(height: 6),
                  Row(children: [
                    ServerBadge(name: s.server.name, color: color),
                    if (s.lastActivity != null) ...[
                      const SizedBox(width: 8),
                      Text(relativeTime(s.lastActivity), style: muted),
                    ],
                    const Spacer(),
                    if (actions.onPin != null)
                      OutlinedButton(
                        style: _smallButton,
                        onPressed: actions.onPin,
                        child: const Text('Pin work item'),
                      ),
                    ?more,
                  ]),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static final ButtonStyle _smallButton = OutlinedButton.styleFrom(
    visualDensity: VisualDensity.compact,
    padding: const EdgeInsets.symmetric(horizontal: 10),
    minimumSize: const Size(0, 30),
    textStyle: const TextStyle(fontSize: 12),
  );

  Widget _itemRow(BuildContext context, BriefItem it) {
    final theme = Theme.of(context);
    final ref = Text(it.ref,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: theme.colorScheme.primary,
          fontFamily: 'monospace',
          fontFamilyFallback: const ['Consolas', 'Menlo', 'Courier New'],
          fontSize: 12,
          decoration: it.url != null ? TextDecoration.underline : null,
        ));
    final uri = it.url == null ? null : Uri.tryParse(it.url!);
    return Tooltip(
      message: it.note,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          // Flexible: a qualified ref (`owner/repo#306`) beside a state pill and an
          // unpin button is wider than a phone card. The ref gives way, not the pill.
          Flexible(
            child: uri != null
                ? InkWell(
                    onTap: () => launchUrl(uri, mode: LaunchMode.externalApplication),
                    child: ref,
                  )
                : ref,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(it.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
          ),
          if (it.state != null) ...[const SizedBox(width: 6), _StatePill(it.state!)],
          if (it.pinned && actions.onUnpin != null)
            IconButton(
              tooltip: 'Unpin ${it.ref}',
              visualDensity: VisualDensity.compact,
              iconSize: 16,
              icon: const Icon(Icons.close),
              onPressed: () => actions.onUnpin!(it),
            ),
        ]),
      ),
    );
  }
}

/// One line for a session that has nothing to read: not reported, done, or hidden.
/// It keeps every action a card has, in its ⋮ menu (pinning included).
class BoardRow extends StatelessWidget {
  const BoardRow({super.key, required this.session, required this.actions, this.color, this.unhide = false});

  final Session session;
  final BoardActions actions;
  final Color? color;

  /// In the Hidden tab: an Unhide button rather than the menu's hide.
  final bool unhide;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = session;
    final st = boardStatusOf(s);
    final more = unhide ? null : _moreMenu(s, actions, includePin: true);
    final artifacts = s.brief?.artifacts ?? const <BriefArtifact>[];
    return Opacity(
      opacity: s.reason?.kind == 'done' ? 0.55 : 1,
      child: Material(
        color: AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.medium),
          side: const BorderSide(color: AppColors.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: _Striped(
          color: color,
          child: InkWell(
            onTap: actions.onOpen,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  StatusDot(status: st.dot, size: 8),
                  const SizedBox(width: 8),
                  // The name takes ALL the free room; the chip is capped and ellipsises
                  // (#313 review: flexed siblings each kept a share, leaving the name a
                  // third of a phone row even when the chip was one short word).
                  Expanded(
                    child: Text(s.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ),
                  const SizedBox(width: 8),
                  ServerBadge(name: s.server.name, color: color),
                  const SizedBox(width: 8),
                  ConstrainedBox(constraints: const BoxConstraints(maxWidth: 150), child: _statusOrReason(s)),
                  if (unhide && actions.onHide != null)
                    TextButton(onPressed: actions.onHide, child: const Text('Unhide'))
                  else if (more != null)
                    more
                  else
                    const SizedBox(height: 40),
                ]),
                // A done session is a row, and a finished one is exactly where its
                // overview artifact is worth finding again (#329).
                if (artifacts.isNotEmpty)
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 8, 6), child: ArtifactLinks(artifacts)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// #329 - the claude.ai artifacts a session published, newest first. Each is a link
/// that opens in the browser; tapping one never opens the session behind it.
class ArtifactLinks extends StatelessWidget {
  const ArtifactLinks(this.artifacts, {super.key});
  final List<BriefArtifact> artifacts;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary);
    return Wrap(spacing: 6, runSpacing: 4, children: [
      for (final a in artifacts)
        Tooltip(
          message: a.title,
          child: InkWell(
            key: ValueKey('board-artifact-${a.url}'),
            borderRadius: BorderRadius.circular(999),
            onTap: () {
              final uri = Uri.tryParse(a.url);
              if (uri != null) launchUrl(uri, mode: LaunchMode.externalApplication);
            },
            child: Container(
              constraints: const BoxConstraints(maxWidth: 260),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.outlineVariant),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.open_in_new, size: 12, color: theme.colorScheme.primary),
                const SizedBox(width: 4),
                Flexible(child: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
              ]),
            ),
          ),
        ),
    ]);
  }
}

/// A size for a glance at a whole machine: `1.3 TB`, `169 GB`, `3.2 GB`, `—` unknown.
String machineSize(int? bytes) {
  if (bytes == null || bytes < 0) return '—';
  const gb = 1024 * 1024 * 1024;
  if (bytes >= 1024 * gb) return '${(bytes / (1024 * gb)).toStringAsFixed(1)} TB';
  return bytes >= 10 * gb ? '${(bytes / gb).round()} GB' : '${(bytes / gb).toStringAsFixed(1)} GB';
}

String _machineUptime(int? sec) {
  if (sec == null || sec < 0) return '';
  final d = sec ~/ 86400, h = (sec % 86400) ~/ 3600;
  return d > 0 ? 'up ${d}d ${h}h' : 'up ${h}h ${(sec % 3600) ~/ 60}m';
}

/// One machine in the dashboard's Machines section (#331). Colours follow the SERVER's
/// `level` on each reading; this widget holds no thresholds.
class MachineCard extends StatelessWidget {
  const MachineCard({super.key, required this.name, this.color, this.note, this.profile});
  final String name;
  final Color? color;

  /// Shown instead of readings (offline, too old, reading…), or null.
  final String? note;
  final MachineProfile? profile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    Color? tint(String? level) => switch (level) {
          'hot' => theme.colorScheme.error,
          'warn' => kWarnAmber,
          _ => null,
        };
    Widget row(String label, String value, [String? level]) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 1),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 104, child: Text(label, style: muted)),
            Expanded(child: Text(value, style: small?.copyWith(color: tint(level)))),
          ]),
        );
    String free(MachineFree? f) =>
        f == null ? '—' : '${machineSize(f.freeBytes)} free of ${machineSize(f.totalBytes)}';
    final p = profile;
    final up = _machineUptime(p?.uptimeSec);
    final s = p?.sessions;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              ServerSwatch(color: color),
              Expanded(child: Text(name, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
              if (up.isNotEmpty) Text(up, style: muted),
            ]),
            const SizedBox(height: 6),
            if (note != null || p == null)
              Text(note ?? 'reading…', style: muted)
            else ...[
              row('Sessions', s == null ? '—' : '${s.count} of ${s.max} · ${s.working} working · ${s.waiting} waiting',
                  s?.level),
              row('CPU', '${p.cpuPct == null ? '—' : '${p.cpuPct}%'}${p.cores == null ? '' : ' of ${p.cores} cores'}',
                  p.cpuLevel),
              row('Memory', free(p.memory), p.memory?.level),
              row('Virtual memory', free(p.commit), p.commit?.level),
              if (p.disks == null || p.disks!.isEmpty)
                row('Disk', '—')
              else
                for (final (i, d) in p.disks!.indexed) row(i == 0 ? 'Disk' : '', '${d.root} ${free(d)}', d.level),
            ],
          ],
        ),
      ),
    );
  }
}

class _ClosedStrip extends StatelessWidget {
  const _ClosedStrip({required this.closed, required this.colorOf});
  final List<ClosedSession> closed;
  final Color? Function(String baseUrl) colorOf;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceVariant);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Closed in the last 24h', style: theme.textTheme.titleSmall),
          const SizedBox(height: 6),
          for (final c in closed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(c.name, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                  ServerBadge(name: c.server.name, color: colorOf(c.server.baseUrl)),
                  if (c.items.isNotEmpty)
                    Text(
                        c.items
                            .map((i) => i.state == null ? i.ref : '${i.ref} ${briefStateLabel(i.state!)}')
                            .join(', '),
                        style: theme.textTheme.bodySmall),
                  if ((c.did?.text ?? c.headline) != null)
                    Text(c.did?.text ?? c.headline!, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
                  if (c.artifacts.isNotEmpty) ArtifactLinks(c.artifacts),
                  if (c.at != null) Text(relativeTime(c.at), style: muted),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Asks for a work item to pin: a reference, a title and a state.
class _PinDialog extends StatefulWidget {
  const _PinDialog();

  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _ref = TextEditingController();
  final _title = TextEditingController();
  String? _state;

  @override
  void dispose() {
    _ref.dispose();
    _title.dispose();
    super.dispose();
  }

  void _save() {
    final ref = _ref.text.trim();
    if (ref.isEmpty) return;
    Navigator.of(context).pop(BriefItem(ref: ref, key: ref, title: _title.text.trim(), state: _state, pinned: true));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      // Scrollable: with a phone keyboard up there is not room for all three fields.
      scrollable: true,
      title: const Text('Pin a work item'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            key: const ValueKey('pin-ref'),
            controller: _ref,
            autofocus: true,
            maxLength: 60,
            decoration: const InputDecoration(labelText: 'Reference', hintText: '#123 or ado:12345'),
            onSubmitted: (_) => _save(),
          ),
          TextField(
            key: const ValueKey('pin-title'),
            controller: _title,
            maxLength: 140,
            decoration: const InputDecoration(labelText: 'Title'),
            onSubmitted: (_) => _save(),
          ),
          DropdownButtonFormField<String?>(
            key: const ValueKey('pin-state'),
            initialValue: _state,
            // Expanded: a long state label ellipsises inside a narrow dialog.
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'State'),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('—')),
              for (final st in kBriefItemStates)
                DropdownMenuItem<String?>(value: st, child: Text(briefStateLabel(st))),
            ],
            onChanged: (v) => setState(() => _state = v),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(key: const ValueKey('pin-save'), onPressed: _save, child: const Text('Pin')),
      ],
    );
  }
}
