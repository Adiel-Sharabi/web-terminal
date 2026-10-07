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
// repeated), an Active / Hidden split (hidden is stored on the session's server, so
// every device agrees), a reason / server / work-item grouping, a text and machine
// filter, and an order. #315 gives every card its machine's colour as a stripe.

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

/// How the board is grouped.
enum BoardGrouping { reason, server, item }

/// The order inside a section. `list` is the session list's own order.
enum BoardSort { list, recent, name, machine }

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

/// One "by work item" section: the item, the sessions whose card shows under it (it
/// is their FIRST item), and the ones that only reference it (a later item of theirs).
class WorkItemGroup {
  final BriefItem item;
  final List<Session> sessions;
  final List<Session> refs;
  const WorkItemGroup(this.item, this.sessions, [this.refs = const []]);
}

/// Groups [sessions] by work item, on the server's cross-session [BriefItem.key]. Each
/// session's CARD appears once, under its first item; its other items list it in
/// [WorkItemGroup.refs] instead of repeating the card. Sessions with no item come back
/// separately. Order is first appearance.
({List<WorkItemGroup> groups, List<Session> none}) groupByWorkItem(List<Session> sessions) {
  final byKey = <String, ({BriefItem item, List<Session> cards, List<Session> refs})>{};
  final none = <Session>[];
  for (final s in sessions) {
    final items = s.brief?.items ?? const <BriefItem>[];
    if (items.isEmpty) {
      none.add(s);
      continue;
    }
    for (var i = 0; i < items.length; i++) {
      final g = byKey.putIfAbsent(items[i].key, () => (item: items[i], cards: <Session>[], refs: <Session>[]));
      (i == 0 ? g.cards : g.refs).add(s);
    }
  }
  return (
    groups: [for (final g in byKey.values) WorkItemGroup(g.item, g.cards, g.refs)],
    none: none,
  );
}

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

/// The summary chips (#318). Each one is a COUNT and a FILTER over the same test, so
/// the number on a chip and the sessions it shows can never disagree.
enum BoardChip {
  you('need you', StatusColor.waiting),
  working('working', StatusColor.working),
  self('on its own', StatusColor.capped),
  capped('capped', StatusColor.capped);

  const BoardChip(this.word, this.color);
  final String word;
  final Color color;

  bool test(Session s) => switch (this) {
        BoardChip.you => boardNeedsYou(s),
        BoardChip.working => s.status == 'working',
        BoardChip.self => s.reason?.kind == 'self' && s.reason?.source != 'usage-limit',
        BoardChip.capped => s.usageLimit?.waiting == true,
      };

  String label(int n) => this == BoardChip.you ? '$n need${n == 1 ? 's' : ''} you' : '$n $word';
}

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

/// Whether [s] passes the text filter [query] and the machine filter [servers]
/// (base URLs; empty = every machine).
bool boardMatches(Session s, String query, Set<String> servers) {
  if (servers.isNotEmpty && !servers.contains(s.server.baseUrl)) return false;
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  final b = s.brief;
  final hay = [
    s.name, s.server.name, b?.headline ?? '', s.reason?.text ?? '',
    for (final it in b?.items ?? const <BriefItem>[]) ...[it.ref, it.title],
  ].join(' ').toLowerCase();
  return hay.contains(q);
}

/// [list] in [sort] order. `list` keeps the order given (the session list's own);
/// `machine` orders by [serverOrder] (base URLs) and keeps list order within each.
List<Session> boardSorted(List<Session> list, BoardSort sort, List<String> serverOrder) {
  final index = {for (var i = 0; i < list.length; i++) list[i]: i};
  final out = [...list];
  int byList(Session a, Session b) => index[a]!.compareTo(index[b]!);
  switch (sort) {
    case BoardSort.list:
      break;
    case BoardSort.recent:
      out.sort((a, b) => (b.lastActivity ?? 0).compareTo(a.lastActivity ?? 0));
    case BoardSort.name:
      out.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    case BoardSort.machine:
      int srv(Session s) {
        final i = serverOrder.indexOf(s.server.baseUrl);
        return i < 0 ? serverOrder.length : i;
      }
      out.sort((a, b) {
        final c = srv(a).compareTo(srv(b));
        return c != 0 ? c : byList(a, b);
      });
  }
  return out;
}

/// The sessions dashboard. [onOpenSession] is called when a card is tapped; the
/// caller decides how to show it (split pane or a pushed route).
class WorkBoardScreen extends StatefulWidget {
  const WorkBoardScreen({
    super.key,
    required this.onOpenSession,
    this.repository,
    this.servers,
    this.clientFactory,
    this.pollInterval = const Duration(seconds: 5),
  });

  final void Function(Session session) onOpenSession;

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
  static const _prefsKey = 'wt.dashboard.view';

  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  StreamSubscription<List<Session>>? _sub;
  Timer? _poll;
  List<Session> _sessions = const [];
  final Map<String, ({DateTime at, List<ClosedSession> list})> _closed = {};
  DateTime? _updatedAt;
  BoardGrouping _grouping = BoardGrouping.reason;
  BoardSort _sort = BoardSort.list;
  bool _showHidden = false;
  String _query = '';
  final Set<String> _serverFilter = {};
  BoardChip? _chipFilter;
  bool _doneOpen = false;

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
      setState(() {
        _sessions = list;
        _updatedAt = DateTime.now();
      });
      unawaited(_refreshClosed());
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

  // Grouping and order are per DEVICE (a phone and a desk can want different views);
  // what a session IS (hidden, favourite) lives on its server.
  Future<void> _loadPrefs() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      if (raw == null) return;
      final m = jsonDecode(raw);
      if (m is! Map || !mounted) return;
      setState(() {
        _grouping = BoardGrouping.values.firstWhere((g) => g.name == m['group'], orElse: () => _grouping);
        _sort = BoardSort.values.firstWhere((s) => s.name == m['sort'], orElse: () => _sort);
      });
    } catch (_) {/* defaults */}
  }

  Future<void> _savePrefs() async {
    try {
      await (await SharedPreferences.getInstance())
          .setString(_prefsKey, jsonEncode({'group': _grouping.name, 'sort': _sort.name}));
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

  void _say(String text, {SnackBarAction? action}) {
    // An Undo outlives the screen (the snackbar is the root messenger's), so its
    // failure can land here after the board was closed.
    if (!mounted) return;
    final m = ScaffoldMessenger.maybeOf(context);
    m?.hideCurrentSnackBar();
    m?.showSnackBar(SnackBar(content: Text(text), action: action, duration: const Duration(seconds: 5)));
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
      onClearWait: (_repo.supportsClearWait(base) && s.reason?.kind == 'you' && s.reason?.source == 'reported')
          ? () => _patch(s, clearWait: true)
          : null,
      onStar: _repo.supportsFavorites(base) ? () => _toggleStar(s) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final all = _sessions;
    final servers = _servers;
    final hidden = all.where(boardIsHidden).toList();
    final shown = all.where((s) => !boardIsHidden(s)).toList();
    final pool = (_showHidden ? hidden : shown)
        .where((s) => boardMatches(s, _query, _serverFilter) && (_chipFilter?.test(s) ?? true))
        .toList();
    final needs = all.where(boardNeedsYou).toList();
    final serverOrder = [for (final sv in servers) sv.baseUrl];
    final closed = _closed.values.expand((v) => v.list).toList()
      ..sort((a, b) => (b.at ?? 0).compareTo(a.at ?? 0));

    // Needs you is always complete, a hidden session included. In the reason grouping
    // the visible ones ARE the first section, so only hidden ones ride the strip.
    final strip = _grouping == BoardGrouping.reason ? needs.where(boardIsHidden).toList() : needs;

    final children = <Widget>[
      _Controls(
        query: _query,
        onQuery: (v) => setState(() => _query = v),
        servers: servers,
        serverFilter: _serverFilter,
        colorOf: _colorOf,
        onToggleServer: (url) => setState(() {
          if (!_serverFilter.remove(url)) _serverFilter.add(url);
        }),
      ),
      _SummaryRow(
        sessions: all.length,
        servers: servers.length,
        counts: {for (final c in BoardChip.values) c: all.where(c.test).length},
        selected: _chipFilter,
        onTap: (c) => setState(() => _chipFilter = _chipFilter == c ? null : c),
        updatedAt: _updatedAt,
      ),
      if (!_showHidden && strip.isNotEmpty) _NeedsYou(sessions: strip, onOpen: widget.onOpenSession),
    ];

    if (_showHidden) {
      children.add(pool.isEmpty
          ? _Empty(hidden.isEmpty ? 'Nothing is hidden. Hide a session from its ⋮ menu.' : 'No hidden session matches the filter.')
          : _Section(title: 'Hidden', rows: true, children: [
              for (final s in boardSorted(pool, _sort, serverOrder))
                BoardRow(key: _key(s), session: s, color: _colorOf(s.server.baseUrl), actions: _actionsFor(s), unhide: true),
            ]));
    } else if (all.isEmpty) {
      children.add(const _Empty('No sessions on any server.'));
    } else if (pool.isEmpty) {
      children.add(const _Empty('No session matches the filter.'));
    } else {
      // Favourites first, and MOVED there rather than repeated below: a card is tall,
      // and a duplicate doubles the scroll and makes every count ambiguous. They keep
      // the session list's pinned order whatever the sort: that order is the owner's.
      final favs = Session.pinnedOrder(pool);
      final rest = pool.where((s) => !s.favorite).toList();
      if (favs.isNotEmpty) {
        children.add(_Section(
          key: const ValueKey('board-favorites'),
          title: '★ Favorites',
          trailing: [_countText(favs.length)],
          children: [for (final s in favs) _card(s)],
        ));
      }
      children.addAll(switch (_grouping) {
        BoardGrouping.reason => _reasonSections(boardSorted(rest, _sort, serverOrder)),
        BoardGrouping.server => [for (final sv in servers) ?_serverSection(sv, boardSorted(rest, _sort, serverOrder))],
        BoardGrouping.item => _itemSections(boardSorted(rest, _sort, serverOrder)),
      });
    }
    if (!_showHidden && closed.isNotEmpty) children.add(_ClosedStrip(closed: closed, colorOf: _colorOf));
    children.add(const SizedBox(height: 24));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        actions: [
          PopupMenuButton<BoardSort>(
            key: const ValueKey('board-sort'),
            tooltip: 'Order',
            icon: const Icon(Icons.sort),
            initialValue: _sort,
            onSelected: (v) {
              setState(() => _sort = v);
              unawaited(_savePrefs());
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: BoardSort.list, child: Text('List order')),
              PopupMenuItem(value: BoardSort.recent, child: Text('Recently active')),
              PopupMenuItem(value: BoardSort.name, child: Text('Name A–Z')),
              PopupMenuItem(value: BoardSort.machine, child: Text('Machine')),
            ],
          ),
        ],
        // Below the title rather than in `actions`: a phone has no room for both.
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                SegmentedButton<bool>(
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
                const SizedBox(width: 10),
                SegmentedButton<BoardGrouping>(
                  key: const ValueKey('board-grouping'),
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: BoardGrouping.reason, label: Text('By reason')),
                    ButtonSegment(value: BoardGrouping.server, label: Text('By server')),
                    ButtonSegment(value: BoardGrouping.item, label: Text('By work item')),
                  ],
                  selected: {_grouping},
                  onSelectionChanged: (v) {
                    setState(() => _grouping = v.first);
                    unawaited(_savePrefs());
                  },
                ),
              ]),
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

  Widget? _serverSection(ServerConfig sv, List<Session> rest) {
    if (_serverFilter.isNotEmpty && !_serverFilter.contains(sv.baseUrl)) return null;
    final mine = rest.where((s) => s.server.baseUrl == sv.baseUrl).toList();
    final needsAuth = _repo.serverNeedsAuth[sv.baseUrl] == true;
    final offline = _repo.serverOfflineConfirmed[sv.baseUrl] == true;
    final version = _repo.serverVersion(sv.baseUrl);
    final (label, color) = needsAuth
        ? ('needs login', StatusColor.serverNeedsAuth)
        : offline
            ? ('offline', StatusColor.serverOffline)
            : ('online${version == null ? '' : ' · $version'}', StatusColor.serverOnline);
    return _Section(
      title: sv.name,
      swatch: _colorOf(sv.baseUrl),
      trailing: [
        Text('● $label', style: TextStyle(color: color, fontSize: 12)),
        _countText(mine.length),
      ],
      children: [for (final s in mine) _card(s)],
    );
  }

  List<Widget> _itemSections(List<Session> rest) {
    final g = groupByWorkItem(rest);
    return [
      for (final grp in g.groups)
        _Section(
          title: '${grp.item.ref} ${grp.item.title}'.trim(),
          trailing: [
            if (grp.item.state != null) _StatePill(grp.item.state!),
            _countText(grp.sessions.length + grp.refs.length),
          ],
          footer: grp.refs.isEmpty
              ? null
              : Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final s in grp.refs)
                    _SeeRef(
                      session: s,
                      color: _colorOf(s.server.baseUrl),
                      firstRef: s.brief!.items.first.ref,
                      onOpen: () => widget.onOpenSession(s),
                    ),
                ]),
          children: [for (final s in grp.sessions) _card(s)],
        ),
      if (g.none.isNotEmpty)
        _Section(title: 'No work item', rows: true, trailing: [_countText(g.none.length)], children: [
          for (final s in g.none) _row(s),
        ]),
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

class _Controls extends StatelessWidget {
  const _Controls({
    required this.query,
    required this.onQuery,
    required this.servers,
    required this.serverFilter,
    required this.colorOf,
    required this.onToggleServer,
  });
  final String query;
  final ValueChanged<String> onQuery;
  final List<ServerConfig> servers;
  final Set<String> serverFilter;
  final Color? Function(String baseUrl) colorOf;
  final ValueChanged<String> onToggleServer;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          key: const ValueKey('board-search'),
          onChanged: onQuery,
          decoration: const InputDecoration(
            isDense: true,
            prefixIcon: Icon(Icons.search, size: 18),
            hintText: 'Filter sessions',
            border: OutlineInputBorder(),
          ),
        ),
        if (servers.length > 1)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final sv in servers)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: FilterChip(
                      key: ValueKey('board-srv-${sv.baseUrl}'),
                      avatar: ServerSwatch(color: colorOf(sv.baseUrl)),
                      label: Text(sv.name),
                      selected: serverFilter.contains(sv.baseUrl),
                      showCheckmark: false,
                      onSelected: (_) => onToggleServer(sv.baseUrl),
                    ),
                  ),
              ]),
            ),
          ),
      ]),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({
    required this.sessions,
    required this.servers,
    required this.counts,
    required this.selected,
    required this.onTap,
    required this.updatedAt,
  });
  final int sessions, servers;
  final Map<BoardChip, int> counts;
  final BoardChip? selected;
  final ValueChanged<BoardChip> onTap;
  final DateTime? updatedAt;

  @override
  Widget build(BuildContext context) {
    Widget chip(String text, Color fg, {bool on = false, VoidCallback? tap, Key? key}) {
      final body = Container(
        key: key,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: fg.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: on ? fg : Colors.transparent),
        ),
        child: Text(on ? '$text  ✕' : text, style: TextStyle(color: fg, fontSize: 12)),
      );
      return tap == null ? body : InkWell(borderRadius: BorderRadius.circular(999), onTap: tap, child: body);
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          chip('$sessions session${sessions == 1 ? '' : 's'} · $servers server${servers == 1 ? '' : 's'}',
              AppColors.onSurfaceVariant),
          // #318: each count filters to those sessions; tap again for all. The selected
          // chip stays even at 0, so the way out of the filter never disappears.
          for (final c in BoardChip.values)
            if ((counts[c] ?? 0) > 0 || selected == c)
              chip(c.label(counts[c] ?? 0), c.color,
                  on: selected == c, tap: () => onTap(c), key: ValueKey('board-chip-${c.name}')),
          if (updatedAt != null)
            Text('updated ${relativeTime(updatedAt!.millisecondsSinceEpoch)}',
                style: const TextStyle(color: AppColors.onSurfaceVariant, fontSize: 11)),
        ],
      ),
    );
  }
}

class _NeedsYou extends StatelessWidget {
  const _NeedsYou({required this.sessions, required this.onOpen});
  final List<Session> sessions;
  final void Function(Session) onOpen;

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
            ActionChip(
              avatar: const StatusDot(status: SessionStatus.waiting, size: 8),
              label: Text('${s.name} · ${s.server.name} · '
                  '${s.reason?.kind == 'menu' ? 'stuck in a menu (Esc)' : s.reason?.kind == 'you' && s.reason!.text.isNotEmpty ? s.reason!.text : s.waitingFor == 'question' ? 'a question' : 'a permission'}'
                  '${boardIsHidden(s) ? ' · hidden' : ''}'),
              onPressed: () => onOpen(s),
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
    this.swatch,
    this.collapsed = false,
    this.onToggle,
    this.footer,
  });
  final String title;
  final List<Widget> trailing;
  final List<Widget> children;

  /// One-line rows in a column rather than cards in a grid.
  final bool rows;
  final Color? swatch;
  final bool collapsed;
  final VoidCallback? onToggle;
  final Widget? footer;

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
          ServerSwatch(color: swatch),
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
          if (!collapsed && footer != null) Padding(padding: const EdgeInsets.only(top: 8), child: footer),
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
              child: Row(children: [
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
            ),
          ),
        ),
      ),
    );
  }
}

/// Under a work item that is NOT a session's first: a one-line link to its card.
class _SeeRef extends StatelessWidget {
  const _SeeRef({required this.session, required this.color, required this.firstRef, required this.onOpen});
  final Session session;
  final Color? color;
  final String firstRef;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: ServerSwatch(color: color),
      label: Text('${session.name} (${session.server.name}) · see $firstRef'),
      onPressed: onOpen,
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
