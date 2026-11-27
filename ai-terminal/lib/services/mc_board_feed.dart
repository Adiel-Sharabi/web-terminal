// #567 - the work board's feed: `GET /api/mc/board` from the server that answered Mission Control's
// Now (the lease authority; [McFeed.servedBy]), read every [pollInterval] while the Board tab is on
// screen and again when the person asks. The server owns every rule; this only fetches and keeps the
// last answer.
//
//  - A 404 (an authority older than the route) is "this server has no board yet": THAT server is not asked
//    again for [kBoardRetry] (a server upgraded since is picked up; a different authority is asked at once),
//    but the Refresh button always asks.
//  - A failed read keeps the last board on screen with a note saying why it is old; another server's
//    board is never kept under this one's.
//  - [refresh] with `candidates: true` asks the server to read the tracker lists again now (`?refresh=1`).
//    The server rate-limits it per source, so a tap cannot hammer a tracker.
//  - Mission Control's feed notifying (it does so often) asks for a board only when there is none yet and the
//    last ask is a poll interval old: a failing board is retried at the poll's pace, never at the feed's.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/mc_models.dart';
import '../api/models.dart' show ServerConfig;
import 'mc_feed.dart';

/// How long a server that answered 404 is left alone.
const Duration kBoardRetry = Duration(minutes: 5);

enum McBoardStatus {
  /// Nothing read yet.
  loading,

  /// [McBoardFeed.board] is the answer (maybe old: see [McBoardFeed.message]).
  ready,

  /// The authority has no `/api/mc/board`.
  unsupported,

  /// Never read, and the read failed ([McBoardFeed.message] says why).
  failed,
}

class McBoardFeed extends ChangeNotifier {
  McBoardFeed({
    required this.feed,
    required this.client,
    this.pollInterval = const Duration(seconds: 30),
    this.isForeground,
    this.retryAfter = kBoardRetry,
  }) {
    feed.addListener(_onFeed);
  }

  /// Mission Control's feed: names the authority server.
  final McFeed feed;
  final ApiClient Function(ServerConfig) client;
  final Duration pollInterval;
  final bool Function()? isForeground;
  final Duration retryAfter;

  McBoardStatus _status = McBoardStatus.loading;
  McBoard? _board;
  String? _message;
  ServerConfig? _boardFrom;
  DateTime? _noBoardUntil;
  String? _noBoardServer;
  DateTime? _askedAt;
  bool _active = false;
  bool _asking = false;
  bool _againCandidates = false;
  bool _againForce = false;
  bool _again = false;
  bool _disposed = false;
  Timer? _timer;

  McBoardStatus get status => _status;

  /// The last answer, kept through a failed read.
  McBoard? get board => _board;

  /// Why [board] is old, or why there is none; null when all is well.
  String? get message => _message;

  /// Whether a read is out.
  bool get busy => _asking;

  /// Polls while true. The Board tab turns it on while it shows.
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

  /// Mission Control found its server after the board asked: read now - but never more often than a poll
  /// (the feed notifies far more often than that, and a failing board would be asked at every notify).
  void _onFeed() {
    if (!_active || _board != null || _asking || feed.servedBy == null) return;
    final at = _askedAt;
    if (at != null && DateTime.now().difference(at) < pollInterval) return;
    unawaited(refresh());
  }

  /// Reads the board. [candidates]: also read the tracker lists again now. [force]: ask even a server that
  /// said 404 lately (the Refresh button). One read at a time; one asked for while another is out runs after it.
  Future<void> refresh({bool candidates = false, bool force = false}) async {
    if (_disposed) return;
    if (_asking) {
      _again = true;
      _againCandidates = _againCandidates || candidates;
      _againForce = _againForce || force;
      return;
    }
    final sv = feed.servedBy;
    if (sv == null) {
      // Mission Control has not found its server: its own screen says so.
      if (_board == null && _status != McBoardStatus.failed) _set(McBoardStatus.loading, null);
      return;
    }
    if (!force &&
        _status == McBoardStatus.unsupported &&
        _noBoardServer == sv.baseUrl &&
        _noBoardUntil != null &&
        DateTime.now().isBefore(_noBoardUntil!)) {
      return;
    }
    _asking = true;
    _askedAt = DateTime.now();
    notifyListeners();
    try {
      final board = await client(sv).mcBoard(refresh: candidates);
      if (_disposed) return;
      _board = board;
      _boardFrom = sv;
      _noBoardUntil = null;
      _noBoardServer = null;
      _set(McBoardStatus.ready, null);
    } on McPeerException {
      _failed(sv, 'it is not the Mission Control server');
    } on ApiException catch (e) {
      if (e.status == 404) {
        // The window starts where the ask was MADE, never slid on by a skipped poll.
        _noBoardUntil = DateTime.now().add(retryAfter);
        _noBoardServer = sv.baseUrl;
        _board = null;
        _boardFrom = null;
        _set(McBoardStatus.unsupported, null);
      } else {
        _failed(sv, e.message);
      }
    } catch (_) {
      _failed(sv, 'unreadable answer');
    } finally {
      _asking = false;
      if (!_disposed) {
        if (_again) {
          final c = _againCandidates;
          final f = _againForce;
          _again = false;
          _againCandidates = false;
          _againForce = false;
          unawaited(refresh(candidates: c, force: f));
        } else {
          notifyListeners();
        }
      }
    }
  }

  void _failed(ServerConfig sv, String why) {
    // Another server's board is never kept under this one.
    if (_boardFrom != null && _boardFrom!.baseUrl != sv.baseUrl) _board = null;
    if (_board == null) {
      _set(McBoardStatus.failed, why);
    } else {
      _set(McBoardStatus.ready, 'The board could not be read: $why');
    }
  }

  void _set(McBoardStatus status, String? message) {
    _status = status;
    _message = message;
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    feed.removeListener(_onFeed);
    super.dispose();
  }
}
