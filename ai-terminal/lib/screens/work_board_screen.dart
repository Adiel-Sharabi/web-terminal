// The sessions board (#306, redesigned by #337): every session on every server in
// three columns - Needs you, Working, Idle / done - with the controls to act on each
// one from here. The owner's brief: a dashboard "I can use to overrule and control all
// of those sessions".
//
// Every rule behind a card is SERVER-side: which work items show and when a report
// is stale (`lib/session-brief.js`), and WHY a session that is not working is not
// working (`lib/session-reason.js`, #313). The session rows come from
// [SessionRepository], which already merges every server client-side; this screen
// adds a faster poll while it is open, and each server's closed list.
//
// The controls never decide WHAT to write. Each one calls the owner of its bytes:
//  * a question's option buttons -> [buildAnswerFrames] + [deliverAnswerFrames] +
//    [awaitAnswerLanded], the question overlay's own path (#19, the hasPreview rules);
//  * a reply -> [buildComposeSubmission], the compose bar's one-frame submit (#44),
//    refused while the agent is not ready (#147);
//  * Stop and Esc -> a lone `0x1b`, which the worker reads as an interrupt only for a
//    `working` session (#55's interrupt contract);
//  * Not waiting -> the existing clearWait PATCH (#320);
//  * Reopen -> `POST /api/sessions` with the resume command the SERVER derived.
// The keys travel through [SessionInputRunner] (`services/session_input.dart`), the
// same `/ws/:id` socket the session screen writes through.
//
// On a wide window the board is what the split's detail pane shows whenever no session
// is open, and the default on launch ([WorkBoardScreen.embedded]); on a phone it is
// pushed full screen and its columns stack.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../services/app_config.dart';
import '../services/session_input.dart';
import '../services/session_repository.dart';
import '../theme/app_theme.dart';
import '../theme/status_colors.dart';
import '../widgets/format_utils.dart';
import '../widgets/question_overlay.dart'
    show answerNeedsConfirm, awaitAnswerLanded, buildAnswerFrames, deliverAnswerFrames;
import '../widgets/reason_chip.dart';
import '../widgets/server_badge.dart';
import '../widgets/status_dot.dart';
import 'session_screen.dart'
    show SubmitUnconfirmedOutcome, buildComposeSubmission, kSubmitPendingGrace, questionSignature,
        resolveSubmitUnconfirmedReaction;

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

/// Why a session shows no work item.
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

/// Hidden from the board (#314).
bool boardIsHidden(Session s) => s.brief?.hidden == true;

/// The reason groups, finest grain. [boardColumnOf] folds them into the three columns.
enum ReasonSection { needsYou, working, self, external, idle, notReported, done }

/// Which reason group [s] belongs in.
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

/// The board's three columns (#337).
enum BoardColumn { needsYou, working, idle }

/// Which column [s] sits in. "Running on its own" and "Blocked on others" are not idle
/// - something is in motion, just not this session's turn - so they are Working.
BoardColumn boardColumnOf(Session s) => switch (reasonSectionOf(s)) {
      ReasonSection.needsYou => BoardColumn.needsYou,
      ReasonSection.working || ReasonSection.self || ReasonSection.external => BoardColumn.working,
      _ => BoardColumn.idle,
    };

/// What a Needs-you card is waiting for, which decides its inline control.
enum NeedKind { question, permission, menu, reported, other }

/// The kind of need, from the server's own fields: `waitingFor` (#79) first, because
/// a live prompt is what actually blocks the agent, then the reason (#313/#316).
NeedKind needKindOf(Session s) {
  if (s.status == 'waiting') {
    if (s.waitingFor == 'question') return NeedKind.question;
    if (s.waitingFor == 'permission') return NeedKind.permission;
  }
  if (s.reason?.kind == 'menu') return NeedKind.menu;
  if (s.reason?.kind == 'you') return NeedKind.reported;
  return NeedKind.other;
}

/// The board's colours (#337): amber for "needs you", blue for "working", muted for
/// idle. One place, resolved per brightness, so the board reads in light and dark.
@immutable
class BoardPalette {
  const BoardPalette._({required this.you, required this.youBg, required this.work, required this.idle});
  final Color you;
  final Color youBg;
  final Color work;
  final Color idle;

  static BoardPalette of(BuildContext context) {
    final t = Theme.of(context);
    final dark = t.brightness == Brightness.dark;
    final you = dark ? AppColors.caution : const Color(0xFFB45F06);
    return BoardPalette._(
      you: you,
      youBg: you.withValues(alpha: dark ? 0.10 : 0.08),
      work: dark ? const Color(0xFF6B9CF0) : const Color(0xFF2F6FD6),
      idle: t.colorScheme.onSurfaceVariant,
    );
  }
}

/// The sessions board. [onOpenSession] is called when a session is opened (a card, a
/// reopened closed session); the caller decides how to show it (split pane or a
/// pushed route).
class WorkBoardScreen extends StatefulWidget {
  const WorkBoardScreen({
    super.key,
    required this.onOpenSession,
    this.embedded = false,
    this.repository,
    this.servers,
    this.clientFactory,
    this.sessionInput,
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

  /// Injectable for tests; defaults to [runWithSessionInput].
  final SessionInputRunner? sessionInput;

  /// How often the board re-asks every server while it is open. The repository's
  /// own 30s timer is too slow for a screen whose whole job is "now".
  final Duration pollInterval;

  @override
  State<WorkBoardScreen> createState() => _WorkBoardScreenState();
}

class _WorkBoardScreenState extends State<WorkBoardScreen> {
  static const _closedEvery = Duration(seconds: 30);
  static const _machineEvery = Duration(seconds: 30);
  static const _questionEvery = Duration(seconds: 4);
  static const _prefsKey = 'wt.dashboard.view';

  late final SessionRepository _repo = widget.repository ?? SessionRepository.instance;
  StreamSubscription<List<Session>>? _sub;
  Timer? _poll;
  List<Session> _sessions = const [];
  final Map<String, ({DateTime at, List<ClosedSession> list})> _closed = {};
  bool _hiddenOpen = false;
  bool _closedOpen = false;

  // #331 - the Machines section. Asked only while it is OPEN: each answer costs its
  // server a CIM query. `failed` keeps "could not read" apart from "not asked yet".
  bool _machinesOpen = false;
  final Map<String, ({DateTime at, MachineProfile? data, bool failed})> _machines = {};

  // #337 - the live question behind each question card, by [_bkey]: asked only for a
  // session that is waiting on one. null = asked, nothing pending.
  final Map<String, PendingQuestion?> _questions = {};
  final Map<String, DateTime> _questionAt = {};

  /// Sessions with a write in flight, so a second press cannot double-answer.
  final Set<String> _busy = {};

  /// The signature of a question answered from here, by [_bkey]: its buttons stay
  /// down until the server stops reporting it, so it cannot be answered twice.
  final Map<String, String> _answered = {};

  /// Closed records reopened from here, so a second press cannot start a second copy.
  final Set<String> _reopened = {};

  // #337 review - a reply is the person's words, so it follows the session screen's
  // rule (#179): kept until delivered, and put back if the agent never took it.
  /// Each reply box's text, by [_bkey]: owned here so a reply can be put back into it.
  final Map<String, TextEditingController> _replyBoxes = {};

  /// The last reply sent from here per session, and when, for a #179 restore.
  final Map<String, ({String text, int at})> _pendingReply = {};

  /// The `submitUnconfirmed` stamp already reacted to, per session.
  final Map<String, int?> _handledUnconfirmed = {};

  TextEditingController _replyBox(Session s) => _replyBoxes.putIfAbsent(_bkey(s), TextEditingController.new);

  List<ServerConfig> get _servers => (widget.servers ?? () => AppConfig.servers)();
  ApiClient _client(ServerConfig s) => (widget.clientFactory ?? ApiClient.new)(s);
  Color? _colorOf(String baseUrl) => colorFromHex(_repo.serverColor(baseUrl));
  SessionInputRunner get _input =>
      widget.sessionInput ?? runWithSessionInput;

  static String _bkey(Session s) => '${s.server.baseUrl}|${s.id}';

  @override
  void initState() {
    super.initState();
    _sessions = _repo.current;
    unawaited(_loadPrefs());
    _sub = _repo.sessions.listen((list) {
      if (!mounted) return;
      setState(() => _sessions = list);
      _checkUnconfirmedReplies();
      unawaited(_refreshClosed());
      unawaited(_refreshMachines());
      unawaited(_refreshQuestions());
    });
    // Only while the app is in the foreground: `main.dart` stops the repository's own
    // polling when the app is backgrounded, and this faster tick must not undo that.
    _poll = Timer.periodic(widget.pollInterval, (_) {
      if (_repo.isForeground) unawaited(_repo.refresh());
    });
    unawaited(_repo.refresh());
    unawaited(_refreshQuestions());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _sub?.cancel();
    for (final c in _replyBoxes.values) {
      c.dispose();
    }
    super.dispose();
  }

  // Which folds are open is per DEVICE (a phone and a desk can want different views);
  // what a session IS (hidden, favourite) lives on its server. A grouping or order an
  // older build saved under the same key is simply ignored (#337).
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
        // Best effort: the list is history, and the live cards are unaffected.
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

  /// #337 - the question behind each question card, from the same route the session
  /// screen's overlay reads (`GET /api/sessions/:id/pending-question`).
  Future<void> _refreshQuestions() async {
    final waiting = _sessions.where((s) => needKindOf(s) == NeedKind.question).toList();
    final live = {for (final s in waiting) _bkey(s)};
    _questions.removeWhere((k, _) => !live.contains(k));
    _questionAt.removeWhere((k, _) => !live.contains(k));
    _answered.removeWhere((k, _) => !live.contains(k));
    final now = DateTime.now();
    final due = waiting.where((s) {
      final at = _questionAt[_bkey(s)];
      return at == null || now.difference(at) > _questionEvery;
    }).toList();
    if (due.isEmpty) return;
    for (final s in due) {
      _questionAt[_bkey(s)] = now;
    }
    await Future.wait(due.map((s) async {
      try {
        _questions[_bkey(s)] = await _client(s.server).pendingQuestion(s.id);
      } catch (_) {/* keep what is shown; the card still offers Open */}
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

  // ---- #337: the controls. Each writes bytes another module owns. -----------------

  /// Runs one write against [s], one at a time per session. False when the session
  /// could not be reached, which is said out loud: nothing was sent.
  Future<bool> _write(Session s, Future<void> Function(void Function(String keys) send) body) async {
    final k = _bkey(s);
    if (_busy.contains(k)) return false;
    setState(() => _busy.add(k));
    final ok = await _input(s, body);
    if (mounted) setState(() => _busy.remove(k));
    if (!ok) _say('Could not reach "${s.name}" - nothing was sent');
    return ok;
  }

  /// Answers a single-select question with option [index], through the overlay's
  /// own frames, pacing and confirm (#19). A question still up after every check is
  /// put back, with a word that it did not take.
  Future<void> _answer(Session s, PendingQuestion q, int index) async {
    final k = _bkey(s);
    final sig = questionSignature(q);
    final frames = buildAnswerFrames(q.questions, [
      {index},
    ]);
    setState(() => _answered[k] = sig);
    PendingQuestion? stuck;
    final ok = await _write(s, (send) async {
      await deliverAnswerFrames(frames, send);
      stuck = await awaitAnswerLanded(
        isSame: (p) => questionSignature(p) == sig,
        resendEnter: answerNeedsConfirm(frames),
        poll: () => _client(s.server).pendingQuestion(s.id),
        resend: () => send('\r'),
      );
    });
    if (!mounted) return;
    if (!ok || stuck != null) setState(() => _answered.remove(k));
    if (ok && stuck != null) _say('The answer did not take - open "${s.name}" to answer it there');
    unawaited(_repo.refresh());
  }

  /// A reply to a session that said it is waiting on you: the compose bar's submit,
  /// one frame (#44). Refused while the agent is not at its composer (#147), as the
  /// compose bar refuses it.
  Future<bool> _reply(Session s, String text) async {
    final val = text.replaceFirst(RegExp(r'[\r\n]+$'), '');
    if (val.trim().isEmpty) return false;
    if (!s.agentReady) {
      _say('"${s.name}" is still starting - nothing was sent');
      return false;
    }
    final sentAt = DateTime.now().millisecondsSinceEpoch;
    final ok = await _write(s, (send) async => send(buildComposeSubmission(val)));
    if (ok) {
      // Delivered to an ATTACHED session (see services/session_input.dart). Whether
      // the agent then took it is #179's verdict, watched in [_checkUnconfirmedReplies].
      _pendingReply[_bkey(s)] = (text: val, at: sentAt);
      unawaited(_repo.refresh());
    }
    return ok;
  }

  /// #179 for the board: a reply the agent's TUI swallowed is reported by the server
  /// as `submitUnconfirmed`. The decision is the session screen's own
  /// ([resolveSubmitUnconfirmedReaction]: only a report stamped at or after this send,
  /// only inside [kSubmitPendingGrace], only into an empty box); this is the glue.
  void _checkUnconfirmedReplies() {
    if (_pendingReply.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final s in _sessions) {
      final k = _bkey(s);
      final pending = _pendingReply[k];
      if (pending == null) continue;
      final at = _repo.submitUnconfirmedAt(s.id);
      final fresh = now - pending.at < kSubmitPendingGrace.inMilliseconds;
      final reaction = resolveSubmitUnconfirmedReaction(
        eventAt: at,
        lastHandledAt: _handledUnconfirmed[k],
        pendingText: fresh ? pending.text : null,
        composeIsEmpty: (_replyBoxes[k]?.text ?? '').isEmpty,
        lastSubmitAt: pending.at,
      );
      if (!fresh) _pendingReply.remove(k);
      if (reaction.outcome == SubmitUnconfirmedOutcome.unchanged) continue;
      _handledUnconfirmed[k] = at;
      if (reaction.outcome == SubmitUnconfirmedOutcome.notMine) continue;
      _repo.clearSubmitUnconfirmed(s.id);
      _pendingReply.remove(k);
      if (reaction.restore) _replyBox(s).text = reaction.text!;
      _say('"${s.name}" did not take your reply'
          '${reaction.restore ? ' - it is back in the box' : ''}. Open it to see what is on its screen.');
    }
  }

  /// A lone Esc: interrupts a working turn, closes a menu over the composer.
  Future<void> _esc(Session s) async {
    if (await _write(s, (send) async => send('\x1b'))) unawaited(_repo.refresh());
  }

  /// Stop = Esc to a session that is STILL working. The card may be up to a poll old,
  /// and an Esc that reaches a session which has since stopped is some other key
  /// (#55), so the status is re-read first.
  Future<void> _stop(Session s) async {
    await _repo.refresh();
    if (!mounted) return;
    final k = _bkey(s);
    final fresh = _repo.current.where((x) => _bkey(x) == k).firstOrNull;
    if (fresh == null || fresh.status != 'working') {
      _say('"${s.name}" is no longer working - Stop was not sent');
      return;
    }
    await _esc(fresh);
  }

  /// The live session that has [c]'s conversation open again, if any: then the record
  /// offers Open rather than a second copy.
  Session? _liveFor(ClosedSession c) {
    final conv = c.claudeSessionId;
    if (conv == null) return null;
    for (final s in _sessions) {
      if (s.server.baseUrl == c.server.baseUrl && s.claudeSessionId == conv) return s;
    }
    return null;
  }

  /// Starts a new session on [c]'s server that resumes its conversation, with the
  /// command and cwd the SERVER derived, then opens it.
  Future<void> _reopen(ClosedSession c) async {
    final k = '${c.server.baseUrl}|${c.id}';
    if (!c.canReopen || _reopened.contains(k)) return;
    setState(() => _reopened.add(k));
    try {
      final created = await _client(c.server)
          .createSession(name: c.name, cwd: c.cwd, autoCommand: c.resumeCommand, agent: c.agent);
      if (!mounted) return;
      unawaited(_repo.refresh());
      widget.onOpenSession(created);
    } catch (e) {
      if (mounted) setState(() => _reopened.remove(k));
      _say('Could not reopen "${c.name}": ${e is ApiException ? e.message : '$e'}');
    }
  }

  BoardActions _actionsFor(Session s) {
    final base = s.server.baseUrl;
    final brief = _repo.supportsBrief(base);
    final k = _bkey(s);
    final q = _questions[k];
    final kind = boardNeedsYou(s) ? needKindOf(s) : null;
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
      question: kind == NeedKind.question ? q : null,
      answering: q != null && _answered[k] == questionSignature(q),
      busy: _busy.contains(k),
      onAnswer: (kind == NeedKind.question && q != null) ? (i) => _answer(s, q, i) : null,
      onReply: kind == NeedKind.reported ? (text) => _reply(s, text) : null,
      replyBox: kind == NeedKind.reported ? _replyBox(s) : null,
      // A lone Esc reads as an interrupt only to a WORKING session; anywhere else it
      // would be some other key (#55), so Stop is offered only there.
      onStop: s.status == 'working' ? () => _stop(s) : null,
      onEsc: kind == NeedKind.menu ? () => _esc(s) : null,
    );
  }

  /// Favourites first, in the session list's pinned order; then the rest in list order.
  static List<Session> _favFirst(List<Session> list) =>
      [...Session.pinnedOrder(list), ...list.where((s) => !s.favorite)];

  @override
  Widget build(BuildContext context) {
    final pal = BoardPalette.of(context);
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: pal.idle);
    final all = _sessions;
    final servers = _servers;
    final hidden = all.where(boardIsHidden).toList();
    final shown = all.where((s) => !boardIsHidden(s)).toList();
    // Needs you is always complete: hiding a session never buries a question it owes.
    final needs = _favFirst(all.where((s) => boardColumnOf(s) == BoardColumn.needsYou).toList());
    final working = _favFirst(shown.where((s) => boardColumnOf(s) == BoardColumn.working).toList());
    final idle = _favFirst(shown.where((s) => boardColumnOf(s) == BoardColumn.idle).toList());
    final closed = _closed.values.expand((v) => v.list).toList()..sort((a, b) => (b.at ?? 0).compareTo(a.at ?? 0));

    Widget card(Session s) => BoardCard(
          key: _key(s),
          session: s,
          color: _colorOf(s.server.baseUrl),
          actions: _actionsFor(s),
        );

    final needsCol = BoardColumnView(
      key: const ValueKey('board-col-you'),
      title: 'Needs you',
      color: pal.you,
      count: needs.length,
      children: needs.isEmpty ? [_ColumnEmpty('Nothing is waiting on you.', style: muted)] : [for (final s in needs) card(s)],
    );
    final workCol = BoardColumnView(
      key: const ValueKey('board-col-work'),
      title: 'Working',
      color: pal.work,
      count: working.length,
      children: working.isEmpty ? [_ColumnEmpty('Nothing is running.', style: muted)] : [for (final s in working) card(s)],
    );
    final idleCol = BoardColumnView(
      key: const ValueKey('board-col-idle'),
      title: 'Idle / done',
      color: pal.idle,
      count: idle.length,
      children: [
        if (idle.isEmpty) _ColumnEmpty(all.isEmpty ? 'No sessions on any server.' : 'Nothing idle.', style: muted),
        for (final s in idle) BoardRow(key: _key(s), session: s, color: _colorOf(s.server.baseUrl), actions: _actionsFor(s)),
        const SizedBox(height: 4),
        _Fold(
          key: const ValueKey('board-hidden'),
          title: 'Hidden (${hidden.length})',
          // A hidden session that owes an answer flags its fold, so hiding never buries one.
          flag: hidden.any(boardNeedsYou) ? pal.you : null,
          open: _hiddenOpen,
          onToggle: () => setState(() => _hiddenOpen = !_hiddenOpen),
          children: hidden.isEmpty
              ? [Text('Nothing is hidden. Hide a session from its ⋮ menu.', style: muted)]
              : [
                  for (final s in hidden)
                    BoardRow(
                        key: ValueKey('board-hidden-${s.server.baseUrl}-${s.id}'),
                        session: s,
                        color: _colorOf(s.server.baseUrl),
                        actions: _actionsFor(s),
                        unhide: true),
                ],
        ),
        if (servers.isNotEmpty)
          _Fold(
            key: const ValueKey('board-machines'),
            title: 'Machines',
            subtitle: 'disk, memory and load: where to open a new session',
            open: _machinesOpen,
            onToggle: _toggleMachines,
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
        if (closed.isNotEmpty)
          _Fold(
            key: const ValueKey('board-closed'),
            title: 'Closed in the last days (${closed.length})',
            open: _closedOpen,
            onToggle: () => setState(() => _closedOpen = !_closedOpen),
            children: [
              ClosedList(
                closed: closed,
                colorOf: _colorOf,
                liveFor: _liveFor,
                reopening: (c) => _reopened.contains('${c.server.baseUrl}|${c.id}'),
                onReopen: _reopen,
                onOpenLive: widget.onOpenSession,
              ),
            ],
          ),
      ],
    );

    return Scaffold(
      appBar: AppBar(
        // Beside the session list there is nothing to go back to (#337).
        automaticallyImplyLeading: !widget.embedded,
        title: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          const Text('Sessions'),
          const SizedBox(width: 12),
          Flexible(
            child: Text('updates every ${widget.pollInterval.inSeconds} s',
                overflow: TextOverflow.ellipsis, style: muted),
          ),
        ]),
      ),
      body: RefreshIndicator(
        onRefresh: _repo.refresh,
        child: LayoutBuilder(builder: (context, box) {
          // Three columns side by side when there is room; stacked on a phone.
          final wide = box.maxWidth >= 720;
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
            children: wide
                ? [
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(child: needsCol),
                      const SizedBox(width: 12),
                      Expanded(child: workCol),
                      const SizedBox(width: 12),
                      Expanded(child: idleCol),
                    ]),
                  ]
                : [needsCol, const SizedBox(height: 16), workCol, const SizedBox(height: 16), idleCol],
          );
        }),
      ),
    );
  }

  Key _key(Session s) => ValueKey('board-${s.server.baseUrl}-${s.id}');
}

/// What a card or row can do, already bound to its session. A null action means the
/// session's server cannot take it (too old) or the session is not in a state where
/// it means anything, so the control is not offered at all.
class BoardActions {
  final VoidCallback onOpen;
  final VoidCallback? onPin;
  final void Function(BriefItem item)? onUnpin;
  final VoidCallback? onToggleReporting;
  final VoidCallback? onHide;
  final VoidCallback? onStar;
  final VoidCallback? onClearWait;

  /// #337 - the live question a question card answers, when it has been read.
  final PendingQuestion? question;

  /// The question above was just answered from here and is still landing.
  final bool answering;

  /// A write to this session is in flight.
  final bool busy;
  final void Function(int option)? onAnswer;
  final Future<bool> Function(String text)? onReply;

  /// The reply box's text, owned by the board so an undelivered reply can be put back.
  final TextEditingController? replyBox;
  final VoidCallback? onStop;
  final VoidCallback? onEsc;

  const BoardActions({
    required this.onOpen,
    this.onPin,
    this.onUnpin,
    this.onToggleReporting,
    this.onHide,
    this.onStar,
    this.onClearWait,
    this.question,
    this.answering = false,
    this.busy = false,
    this.onAnswer,
    this.onReply,
    this.replyBox,
    this.onStop,
    this.onEsc,
  });
}

/// One of the board's three columns: a coloured header with a count, then its cards.
class BoardColumnView extends StatelessWidget {
  const BoardColumnView({super.key, required this.title, required this.color, required this.count, required this.children});
  final String title;
  final Color color;
  final int count;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final head = TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 0.8);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.fromLTRB(2, 4, 2, 4),
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: color, width: 2))),
        child: Row(children: [
          Flexible(child: Text(title.toUpperCase(), style: head, overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 6),
          Text('$count', key: ValueKey('board-count-$title'),
              style: head.copyWith(fontFamily: 'monospace', fontFamilyFallback: const ['Consolas', 'Menlo'])),
        ]),
      ),
      for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 8), child: c),
    ]);
  }
}

class _ColumnEmpty extends StatelessWidget {
  const _ColumnEmpty(this.text, {this.style});
  final String text;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2), child: Text(text, style: style));
}

/// A collapsible group under the Idle column: Hidden, Machines, Closed.
class _Fold extends StatelessWidget {
  const _Fold({
    super.key,
    required this.title,
    required this.open,
    required this.onToggle,
    required this.children,
    this.subtitle,
    this.flag,
  });
  final String title;
  final String? subtitle;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;

  /// A dot after the title, in this colour (a hidden session that needs you).
  final Color? flag;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      InkWell(
        onTap: onToggle,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(children: [
            Icon(open ? Icons.expand_more : Icons.chevron_right, size: 18, color: muted?.color),
            Flexible(
              child: Text(title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
            ),
            if (flag != null)
              Container(
                margin: const EdgeInsets.only(left: 5),
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: flag, shape: BoxShape.circle),
              ),
            if (subtitle != null) ...[
              const SizedBox(width: 8),
              Expanded(child: Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted)),
            ],
          ]),
        ),
      ),
      if (open)
        for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 6), child: c),
    ]);
  }
}

/// The ⋮ menu shared by cards and rows: pin, hide or unhide, star, stop reporting.
Widget? _moreMenu(Session s, BoardActions a) {
  final items = <PopupMenuEntry<String>>[
    if (a.onPin != null) const PopupMenuItem(value: 'pin', child: Text('Pin work item')),
    if (a.onHide != null)
      PopupMenuItem(
        value: 'hide',
        child: Text(boardIsHidden(s) ? 'Unhide' : (s.favorite ? 'Unstar & hide' : 'Hide from dashboard')),
      ),
    if (a.onStar != null) PopupMenuItem(value: 'star', child: Text(s.favorite ? 'Unstar' : 'Star')),
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
      _ => null,
    },
  );
}

final ButtonStyle _smallOutlined = OutlinedButton.styleFrom(
  visualDensity: VisualDensity.compact,
  padding: const EdgeInsets.symmetric(horizontal: 10),
  minimumSize: const Size(0, 30),
  textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
);

final ButtonStyle _smallFilled = FilledButton.styleFrom(
  visualDensity: VisualDensity.compact,
  padding: const EdgeInsets.symmetric(horizontal: 12),
  minimumSize: const Size(0, 30),
  textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
);

final ButtonStyle _compactText = TextButton.styleFrom(
  visualDensity: VisualDensity.compact,
  padding: const EdgeInsets.symmetric(horizontal: 8),
  minimumSize: const Size(0, 32),
  textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
);

/// A labelled line: `<b>Label:</b> text`.
Widget _labelled(BuildContext context, String label, String text, {int maxLines = 3, Key? key}) {
  final theme = Theme.of(context);
  return Text.rich(
    TextSpan(children: [
      TextSpan(text: '$label: ', style: const TextStyle(fontWeight: FontWeight.w700)),
      TextSpan(text: text),
    ]),
    key: key,
    maxLines: maxLines,
    overflow: TextOverflow.ellipsis,
    style: theme.textTheme.bodySmall?.copyWith(fontSize: 13),
  );
}

/// One session's card in the Needs-you or Working column (#337).
class BoardCard extends StatelessWidget {
  const BoardCard({super.key, required this.session, required this.actions, this.color});

  final Session session;
  final BoardActions actions;

  /// The session's machine colour (#315), or null when its server has not said.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pal = BoardPalette.of(context);
    final s = session;
    final b = s.brief;
    final needs = boardNeedsYou(s);
    final muted = theme.textTheme.bodySmall?.copyWith(color: pal.idle);
    final items = b?.items ?? const <BriefItem>[];
    final more = _moreMenu(s, actions);
    final idk = '${s.server.baseUrl}-${s.id}';

    final body = <Widget>[
      _head(context, pal, muted),
      if (needs) ..._needLines(context) else ..._workLines(context, pal),
      for (final it in items) _itemRow(context, it),
      if (b != null && b.artifacts.isNotEmpty) ArtifactLinks(b.artifacts),
      if (b?.staleReason != null)
        Text('⚠ Report may be out of date: ${b!.staleReason}',
            key: const ValueKey('board-stale'), style: const TextStyle(color: AppColors.caution, fontSize: 12)),
      if (needs) ..._needControls(context, idk),
      Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        OutlinedButton(key: ValueKey('board-open-$idk'), style: _smallOutlined, onPressed: actions.onOpen, child: const Text('Open')),
        if (actions.onStop != null)
          OutlinedButton(
            key: ValueKey('board-stop-$idk'),
            style: _smallOutlined.copyWith(foregroundColor: WidgetStatePropertyAll(theme.colorScheme.error)),
            onPressed: actions.busy ? null : actions.onStop,
            child: const Text('Stop'),
          ),
        if (actions.onClearWait != null)
          OutlinedButton(
            key: ValueKey('board-clear-wait-$idk'),
            style: _smallOutlined,
            onPressed: actions.onClearWait,
            child: const Text('Not waiting'),
          ),
        ?more,
      ]),
    ];

    return Opacity(
      opacity: s.reason?.kind == 'done' ? 0.55 : 1,
      child: Material(
        color: needs ? Color.alphaBlend(pal.youBg, theme.colorScheme.surface) : theme.colorScheme.surfaceContainer,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.medium),
          side: BorderSide(color: needs ? pal.you.withValues(alpha: 0.55) : theme.colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: _Striped(
          color: color,
          child: InkWell(
            onTap: actions.onOpen,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 10, 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (final (i, w) in body.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 6), child: w),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _head(BuildContext context, BoardPalette pal, TextStyle? muted) {
    final theme = Theme.of(context);
    final s = session;
    return Row(children: [
      if (!boardNeedsYou(s)) ...[
        Container(width: 8, height: 8, decoration: BoxDecoration(color: pal.work, shape: BoxShape.circle)),
        const SizedBox(width: 8),
      ],
      if (s.favorite) ...[
        const Icon(Icons.star, size: 14, color: AppColors.favorite, semanticLabel: 'Favorite'),
        const SizedBox(width: 4),
      ],
      Expanded(
        child: Text(s.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
      ),
      if (boardIsHidden(s)) ...[const SizedBox(width: 6), Text('hidden', style: muted)],
      const SizedBox(width: 6),
      ServerBadge(name: s.server.name, color: color),
      if (s.lastActivity != null) ...[
        const SizedBox(width: 6),
        Text(relativeTime(s.lastActivity), style: muted),
      ],
    ]);
  }

  /// What the session is waiting for, in its own words where it gave any.
  List<Widget> _needLines(BuildContext context) {
    final s = session;
    final b = s.brief;
    switch (needKindOf(s)) {
      case NeedKind.question:
        final q = actions.question;
        final text = (q == null || q.questions.isEmpty) ? 'reading it…' : q.questions.first.question;
        return [_labelled(context, 'Question', text)];
      case NeedKind.permission:
        return [_labelled(context, 'Permission', b?.now?.text ?? 'a tool wants to run')];
      case NeedKind.menu:
        return [_labelled(context, 'Stuck in a menu', 'a panel covers the composer; Esc closes it')];
      case NeedKind.reported:
        final waiting = s.reason?.text ?? '';
        return [
          if (waiting.isNotEmpty) _labelled(context, 'Waiting', waiting),
          // The ask itself: the session's last TL;DR.
          if (b?.did != null) _labelled(context, 'Asks', b!.did!.text, maxLines: 4),
        ];
      case NeedKind.other:
        return [_labelled(context, 'Needs you', boardStatusOf(s).label)];
    }
  }

  List<Widget> _workLines(BuildContext context, BoardPalette pal) {
    final s = session;
    final b = s.brief;
    final kind = s.reason?.kind;
    final reasonText = hasReasonChip(s.reason) ? reasonLabel(s.reason) : '';
    return [
      if (kind == 'self')
        _labelled(context, 'On its own', s.reason!.text.isEmpty ? reasonText : s.reason!.text)
      else if (kind == 'external')
        _labelled(context, 'Blocked on others', s.reason!.text.isEmpty ? 'waiting on someone else' : s.reason!.text)
      else if (b?.now != null && s.status == 'working')
        _labelled(context, 'Now', b!.now!.text)
      else
        _labelled(context, boardStatusOf(s).label, b?.headline ?? '…'),
      if (b?.did != null)
        Text('Last did: ${b!.did!.text}',
            maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: pal.idle, fontSize: 12)),
    ];
  }

  /// The inline control for this kind of need.
  List<Widget> _needControls(BuildContext context, String idk) {
    final s = session;
    switch (needKindOf(s)) {
      case NeedKind.question:
        final q = actions.question;
        if (q == null) return const [];
        if (actions.answering) {
          return [Text('Answer sent - waiting for it to land…', style: Theme.of(context).textTheme.bodySmall)];
        }
        // Option buttons only where one press IS the whole answer: one question, one
        // choice. Several questions, or several choices, are answered in the session.
        final simple = q.questions.length == 1 && !q.questions.first.multiSelect && actions.onAnswer != null;
        if (!simple) {
          return [Text('Several answers are needed - Open to answer.', style: Theme.of(context).textTheme.bodySmall)];
        }
        return [
          Wrap(spacing: 6, runSpacing: 4, children: [
            for (final (i, o) in q.questions.first.options.indexed)
              OutlinedButton(
                key: ValueKey('board-answer-$idk-$i'),
                style: _smallOutlined,
                onPressed: actions.busy ? null : () => actions.onAnswer!(i),
                child: Text(o.label),
              ),
            // Free text has its own rules per layout (#143); the session's overlay owns them.
            OutlinedButton(
                key: ValueKey('board-other-$idk'), style: _smallOutlined, onPressed: actions.onOpen, child: const Text('Other…')),
          ]),
        ];
      case NeedKind.permission:
        return [
          Text('Allow or deny it in the session.', style: Theme.of(context).textTheme.bodySmall),
        ];
      case NeedKind.menu:
        if (actions.onEsc == null) return const [];
        return [
          OutlinedButton(
            key: ValueKey('board-esc-$idk'),
            style: _smallOutlined,
            onPressed: actions.busy ? null : actions.onEsc,
            child: const Text('Send Esc'),
          ),
        ];
      case NeedKind.reported:
        if (actions.onReply == null || actions.replyBox == null) return const [];
        return [
          _ReplyBox(
            key: ValueKey('board-reply-$idk'),
            controller: actions.replyBox!,
            name: s.name,
            ready: s.agentReady,
            busy: actions.busy,
            onSend: actions.onReply!,
          ),
        ];
      case NeedKind.other:
        return const [];
    }
  }

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
    );
  }
}

/// The one-line reply under a "waiting on you" card (#337). Sends through
/// [BoardActions.onReply], which submits exactly as the compose bar does.
class _ReplyBox extends StatefulWidget {
  const _ReplyBox({
    super.key,
    required this.controller,
    required this.name,
    required this.ready,
    required this.busy,
    required this.onSend,
  });
  final TextEditingController controller;
  final String name;
  final bool ready;
  final bool busy;
  final Future<bool> Function(String text) onSend;

  @override
  State<_ReplyBox> createState() => _ReplyBoxState();
}

class _ReplyBoxState extends State<_ReplyBox> {
  TextEditingController get _text => widget.controller;

  Future<void> _send() async {
    final t = _text.text;
    if (t.trim().isEmpty || widget.busy || !widget.ready) return;
    // The words stay in the box until they are DELIVERED to an attached session; if
    // the agent then does not take them, the board puts them back (#179).
    if (await widget.onSend(t) && mounted && _text.text == t) _text.clear();
  }

  @override
  Widget build(BuildContext context) {
    final canSend = widget.ready && !widget.busy;
    return Row(children: [
      Expanded(
        child: TextField(
          key: const ValueKey('board-reply-field'),
          controller: _text,
          minLines: 1,
          maxLines: 1,
          textInputAction: TextInputAction.send,
          onSubmitted: (_) => _send(),
          style: const TextStyle(fontSize: 13),
          decoration: InputDecoration(
            isDense: true,
            hintText: widget.ready ? 'Reply to this session…' : 'Starting the agent…',
            border: const OutlineInputBorder(),
            contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          ),
        ),
      ),
      const SizedBox(width: 6),
      Tooltip(
        message: widget.ready ? 'Send to ${widget.name}' : 'Starting the agent',
        child: FilledButton(
          key: const ValueKey('board-reply-send'),
          style: _smallFilled,
          onPressed: canSend ? _send : null,
          child: const Text('Send'),
        ),
      ),
    ]);
  }
}

/// One compact line for an idle or done session, or a hidden one (with Unhide): name,
/// what it did, Open.
class BoardRow extends StatelessWidget {
  const BoardRow({super.key, required this.session, required this.actions, this.color, this.unhide = false});

  final Session session;
  final BoardActions actions;
  final Color? color;

  /// In the Hidden fold: an Unhide button rather than the menu.
  final bool unhide;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pal = BoardPalette.of(context);
    final s = session;
    final st = boardStatusOf(s);
    final more = unhide ? null : _moreMenu(s, actions);
    final b = s.brief;
    final did = b?.did?.text ?? b?.headline ?? noItemReason(s);
    final artifacts = b?.artifacts ?? const <BriefArtifact>[];
    return Opacity(
      opacity: s.reason?.kind == 'done' ? 0.6 : 1,
      child: Material(
        color: theme.colorScheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppShape.small + 2),
          side: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: _Striped(
          color: color,
          child: InkWell(
            onTap: actions.onOpen,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 2, 2, 2),
              child: LayoutBuilder(builder: (context, box) {
                // What it did sits beside the name when the column is wide enough,
                // and under it when not: the name keeps most of a phone row (#313).
                final inline = box.maxWidth >= 340;
                final didText = Tooltip(
                  message: did,
                  child: Text(did,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(color: pal.idle)),
                );
                final name = Text(s.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700));
                return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    StatusDot(status: st.dot, size: 8),
                    const SizedBox(width: 6),
                    if (s.favorite) ...[
                      const Icon(Icons.star, size: 13, color: AppColors.favorite, semanticLabel: 'Favorite'),
                      const SizedBox(width: 4),
                    ],
                    if (inline) ...[
                      Flexible(flex: 3, child: name),
                      const SizedBox(width: 8),
                      Expanded(flex: 2, child: didText),
                    ] else
                      Expanded(child: name),
                    const SizedBox(width: 6),
                    ServerBadge(name: s.server.name, color: color),
                    if (unhide && actions.onHide != null)
                      TextButton(style: _compactText, onPressed: actions.onHide, child: const Text('Unhide'))
                    else ...[
                      TextButton(
                        key: ValueKey('board-open-${s.server.baseUrl}-${s.id}'),
                        style: _compactText,
                        onPressed: actions.onOpen,
                        child: const Text('Open'),
                      ),
                      if (more != null) more else const SizedBox(height: 40),
                    ],
                  ]),
                  if (!inline) Padding(padding: const EdgeInsets.fromLTRB(14, 0, 8, 4), child: didText),
                  // A done session is a row, and a finished one is exactly where its
                  // overview artifact is worth finding again (#329).
                  if (artifacts.isNotEmpty)
                    Padding(padding: const EdgeInsets.fromLTRB(16, 0, 8, 6), child: ArtifactLinks(artifacts)),
                ]);
              }),
            ),
          ),
        ),
      ),
    );
  }
}

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// The day heading a closed session is grouped under: Today, Yesterday, `Mon 12 Oct`.
String closedDayLabel(int? atMs, {DateTime? now}) {
  if (atMs == null) return 'Earlier';
  final n = now ?? DateTime.now();
  final d = DateTime.fromMillisecondsSinceEpoch(atMs);
  final days = DateTime(n.year, n.month, n.day).difference(DateTime(d.year, d.month, d.day)).inDays;
  if (days <= 0) return 'Today';
  if (days == 1) return 'Yesterday';
  return '${_weekdays[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}';
}

/// #337 - sessions that closed in the last days, newest first, grouped by day: name,
/// what it did, server, and a Reopen that resumes the conversation. A record the
/// server could not name a conversation for is shown greyed, with no button.
class ClosedList extends StatelessWidget {
  const ClosedList({
    super.key,
    required this.closed,
    required this.colorOf,
    required this.liveFor,
    required this.reopening,
    required this.onReopen,
    required this.onOpenLive,
  });
  final List<ClosedSession> closed;
  final Color? Function(String baseUrl) colorOf;
  final Session? Function(ClosedSession c) liveFor;
  final bool Function(ClosedSession c) reopening;
  final void Function(ClosedSession c) onReopen;
  final void Function(Session s) onOpenLive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final rows = <Widget>[];
    String? day;
    for (final c in closed) {
      final label = closedDayLabel(c.at);
      if (label != day) {
        day = label;
        rows.add(Padding(
          padding: const EdgeInsets.only(top: 6, bottom: 2),
          child: Text(label, style: muted?.copyWith(fontWeight: FontWeight.w700)),
        ));
      }
      final live = liveFor(c);
      final what = c.did?.text ?? c.headline;
      final k = '${c.server.baseUrl}-${c.id}';
      final Widget action;
      if (live != null) {
        action = TextButton(key: ValueKey('board-closed-open-$k'), onPressed: () => onOpenLive(live), child: const Text('Open'));
      } else if (c.canReopen) {
        final busy = reopening(c);
        action = OutlinedButton(
          key: ValueKey('board-reopen-$k'),
          style: _smallOutlined,
          onPressed: busy ? null : () => onReopen(c),
          child: Text(busy ? 'Reopening…' : 'Reopen'),
        );
      } else {
        action = const SizedBox.shrink();
      }
      final reopenable = live != null || c.canReopen;
      final Widget row = Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  flex: 3,
                  child: Text(c.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: Text(what ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
                ),
                const SizedBox(width: 6),
                ServerBadge(name: c.server.name, color: colorOf(c.server.baseUrl)),
                const SizedBox(width: 4),
                action,
              ]),
              if (c.items.isNotEmpty)
                Text(c.items.map((i) => i.state == null ? i.ref : '${i.ref} ${briefStateLabel(i.state!)}').join(', '),
                    style: muted),
              if (c.artifacts.isNotEmpty) ArtifactLinks(c.artifacts),
            ]),
          );
      rows.add(Opacity(
        key: ValueKey('board-closed-$k'),
        opacity: reopenable ? 1 : 0.5,
        child: reopenable
            ? row
            : Tooltip(message: 'Its conversation is not known, so it cannot be reopened', child: row),
      ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
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
