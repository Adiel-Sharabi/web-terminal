/// Pinning a session, and whether it can be pinned at all — the ONE owner of
/// both rules (#60, #66, #180).
///
/// These lived as a private method plus a `@visibleForTesting` function inside
/// `dashboard_screen.dart` for as long as the session list was the only place a
/// session could be starred. #180 adds a second place — the open session's own
/// meta bar — and two callers of a rule is exactly where a second copy gets
/// written. There is no local favourites list to keep in step (`Session.favorite`
/// is the server's answer, `models.dart`), so what has to stay single here is the
/// WRITE and the GATE, not the state.
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import 'session_repository.dart';

/// The star's glyph for a given pin state — one owner, so the session LIST row
/// and the session's own meta bar can never render different icons for the same
/// state. (#169 is what a drifted pair of favourite affordances costs.)
IconData favoriteStarIcon(bool isFavorite) =>
    isFavorite ? Icons.star : Icons.star_border;

/// The star's tooltip, named for what pressing it DOES rather than for the state
/// it is in — and shared for the same reason as [favoriteStarIcon].
String favoriteStarTooltip(bool isFavorite) =>
    isFavorite ? 'Remove from favorites' : 'Add to favorites';

/// Whether the pin/unpin star should be offered for a session on its owning
/// server (#60 + #66): the server must both advertise `favorites-sync` AND be
/// currently reachable.
///
/// An offline server would only ever fail the PATCH, so the star is **hidden**
/// rather than wired to a guaranteed failure — the same convention [SessionCard]
/// already gives a caller that omits `onToggleFavorite`. Note `serverOnline` is
/// nullable and `null` means *not yet known*, which counts as allowed: a server
/// we have not heard about yet is not the same as one we know is down, and
/// hiding the control on first paint would make it flicker in.
///
/// Kept as a pure function of its two inputs so the gate is unit-testable
/// without pumping a screen.
bool favoriteToggleAllowed({
  required bool supportsFavorites,
  required bool? serverOnline,
}) =>
    supportsFavorites && serverOnline != false;

/// [favoriteToggleAllowed] answered from the live repository for [session] —
/// the form both call sites actually want, so neither has to remember which two
/// maps to consult.
bool canToggleFavorite(Session session) {
  final repo = SessionRepository.instance;
  return favoriteToggleAllowed(
    supportsFavorites: repo.supportsFavorites(session.server.baseUrl),
    serverOnline: repo.serverOnline[session.server.baseUrl],
  );
}

/// Flips [session]'s pin on the server that OWNS it, then refreshes so every
/// view re-renders from the server's answer.
///
/// There is deliberately **no optimistic local flip**: a favourite is the
/// server's state (it is what makes a pin show up on the phone), so the refresh
/// is what makes the star truthful rather than merely responsive. It is also why
/// nothing has to be rolled back on failure — the write either landed or it did
/// not, and the failure is surfaced via a SnackBar, matching every other session
/// mutation (rename / kill / notify-level, `session_action_sheet.dart`).
Future<void> toggleSessionFavorite(BuildContext context, Session session) async {
  try {
    await ApiClient(session.server).setFavorite(session.id, !session.favorite);
    await SessionRepository.instance.refresh();
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Favorite failed: $e')));
    }
  }
}
