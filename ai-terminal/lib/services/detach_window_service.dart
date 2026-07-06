/// Detach a session into its own OS window (issue #14).
///
/// Rather than an in-process multi-window plugin (fragile native linking on
/// Windows, no benefit here), a detached session is simply a second instance
/// of the app launched with `--session <serverBaseUrl> <sessionId>`. That
/// instance opens straight into a standalone [SessionScreen] for that session,
/// so it's a real, independent OS window you can drag/pin to another monitor.
/// State (drafts, raw-mode, font size) lives in shared preferences, so both
/// windows stay consistent.
library;

import 'dart:io' show Platform, Process, ProcessStartMode;

import 'package:flutter/foundation.dart';

import '../api/models.dart';

/// The CLI flag that tells a fresh instance to open one session standalone.
const String kSessionFlag = '--session';

class DetachWindow {
  DetachWindow._();

  /// Detaching to a new window is a desktop-only affordance.
  static bool get supported =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  /// Launches a new, detached instance of this app showing just [sessionId] on
  /// [server]. Best-effort; a launch failure is swallowed (the caller can keep
  /// using the current window).
  static Future<void> open(ServerConfig server, String sessionId) async {
    if (!supported) return;
    try {
      await Process.start(
        Platform.resolvedExecutable,
        [kSessionFlag, server.baseUrl, sessionId],
        mode: ProcessStartMode.detached,
      );
    } catch (_) {
      // Best-effort — nothing to do if the OS refuses to spawn the window.
    }
  }

  /// Parses `--session <serverBaseUrl> <sessionId>` out of the process args,
  /// or null when the app was launched normally. Pure, so it's unit-testable.
  static DetachedTarget? parseArgs(List<String> args) {
    final i = args.indexOf(kSessionFlag);
    if (i >= 0 && i + 2 < args.length) {
      final baseUrl = args[i + 1];
      final sessionId = args[i + 2];
      if (baseUrl.isNotEmpty && sessionId.isNotEmpty) {
        return DetachedTarget(baseUrl: baseUrl, sessionId: sessionId);
      }
    }
    return null;
  }
}

/// The session a detached window was launched to show.
@immutable
class DetachedTarget {
  const DetachedTarget({required this.baseUrl, required this.sessionId});

  final String baseUrl;
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is DetachedTarget &&
      other.baseUrl == baseUrl &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(baseUrl, sessionId);
}
