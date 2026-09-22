/// Keeps the app's server list in step with the cluster (#97).
///
/// **The problem this solves.** The companion builds its list from its OWN
/// device-local servers — [SessionRepository] calls `GET /api/sessions` on each
/// configured server and merges client-side; it never calls
/// `/api/cluster/sessions`. So joining a box to the cluster server-side left it
/// invisible in every app until someone added it by hand, on every device.
///
/// **How it works.** For each server we can already reach, ask what peers it
/// knows (`GET /api/cluster/servers`). For any peer we do not already hold,
/// ask that same server to obtain a token for us
/// (`POST /api/cluster/client-token`) — it spends the cluster trust it already
/// has, and the peer mints a token for THIS device. Then hand the result to
/// [ServerStore.syncDiscovered], which owns the merge rule.
///
/// **Failure is not removal.** A server that is unreachable contributes nothing
/// to this round, and a round that learned nothing at all makes no changes —
/// otherwise every flaky network moment would delete the user's whole list. Only
/// a peer that a reachable server actively stopped advertising is dropped.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import 'server_store.dart';
import 'session_repository.dart';

/// Builds a client for a server — injectable so tests never touch the network.
typedef ApiClientBuilder = ApiClient Function(ServerConfig server);

/// Whether the token we hold for [baseUrl] was REFUSED by that server (a 401 on
/// the last refresh), keyed by the server's own `baseUrl` exactly as
/// [SessionRepository.serverNeedsAuth] keys it — never a normalised copy, so
/// the two can never disagree about which server is meant.
typedef StaleTokenProbe = bool Function(String baseUrl);

class ClusterDiscovery {
  ClusterDiscovery({
    required ServerStore store,
    ApiClientBuilder? clientBuilder,
    String deviceLabel = 'companion',
    StaleTokenProbe? staleToken,
    // `this._store` is what the lint would prefer, but Dart forbids a PRIVATE
    // named parameter, so the field has to be assigned in the initializer list.
  })  : _build = clientBuilder ?? ApiClient.new,
        _label = deviceLabel,
        _stale = staleToken ?? _refusedByRepository,
        // ignore: prefer_initializing_formals
        _store = store;

  final ServerStore _store;
  final ApiClientBuilder _build;
  final String _label;
  final StaleTokenProbe _stale;

  /// The production probe. Defaulted here rather than required at each call
  /// site on purpose: there are two (`main.dart` and the dashboard's pull), and
  /// a call site that forgot to pass it would silently lose the healing while
  /// looking correct.
  static bool _refusedByRepository(String baseUrl) =>
      SessionRepository.instance.serverNeedsAuth[baseUrl] == true;

  bool _running = false;

  /// Runs one reconciliation pass. Safe to call often; overlapping calls are
  /// dropped rather than queued, because two passes would race on the store.
  ///
  /// Returns true when the stored list actually changed.
  Future<bool> refresh() async {
    if (_running) return false;
    _running = true;
    try {
      final known = _store.servers;
      if (known.isEmpty) return false;

      final byUrl = {for (final s in known) _norm(s.baseUrl): s};

      // Peers advertised by any server we could actually reach this round.
      final advertised = <String, ClusterPeer>{};
      var reachedAny = false;

      for (final server in known) {
        try {
          final peers = await _build(server).listClusterServers();
          reachedAny = true;
          for (final p in peers) {
            final url = _norm(p.url);
            if (url.isEmpty) continue;
            // Skip the advertising server itself; a server lists its peers, but
            // a mesh means someone else lists IT, and adopting our own entry
            // would fight with the user's manual copy of it.
            if (url == _norm(server.baseUrl)) continue;
            advertised.putIfAbsent(url, () => p);
          }
        } catch (_) {
          // Unreachable right now. Contributes nothing; removes nothing.
        }
      }

      // Nothing was reachable -> this round knows nothing. Do NOT let that be
      // read as "the cluster is empty", which would wipe every discovered entry.
      if (!reachedAny) return false;

      final discovered = <ServerConfig>[];
      for (final entry in advertised.entries) {
        final url = entry.key;
        final peer = entry.value;
        final existing = byUrl[url];

        // Already ours by hand: leave it entirely alone (the store enforces this
        // too, but not asking for a token avoids pointless work and log noise).
        //
        // KNOWN GAP, deliberate: this means a MANUALLY-added server whose token
        // has expired is not healed by the re-mint below either. Widening it
        // would also mean changing `syncDiscovered`, which refuses to touch a
        // manual entry at all — a bigger blast radius than this fix wants, and
        // overwriting a credential the user typed is a decision, not a repair.
        // Deleting the entry and letting discovery re-add it converts it to a
        // cluster entry, after which it self-heals for good.
        if (existing != null && existing.origin == ServerOrigin.manual) continue;

        // "Usable" USED TO MEAN "the string is not empty", which is a fact about
        // our storage and not about the server. An app token carries a 90-day
        // expiry and is pruned server-side once past it, so a held token goes
        // dead on a timer with nothing on this device changing — and the peer
        // then answers 401 forever while we sit on the corpse. Measured
        // 2026-09-21: office's companion token expired, was pruned at 00:17,
        // and the phone showed "Office is unreachable" with office healthy and
        // this very re-mint path available and unused.
        final refused = existing != null && _stale(existing.baseUrl);
        if (existing != null && existing.bearerToken.isNotEmpty && !refused) {
          // Known and usable — refresh the name, keep the token.
          discovered.add(existing.copyWith(
            name: peer.name.isEmpty ? existing.name : peer.name,
            origin: ServerOrigin.cluster,
          ));
          continue;
        }

        // Either new to us, or holding a token that server has refused. Both
        // need a token before the entry is of any use.
        if (!peer.hasToken) continue; // the advertiser cannot vouch for it yet
        final token = await _mintVia(known, url);
        // Nobody could get us one. For a REFUSED entry, keep what we have
        // rather than dropping it: `syncDiscovered` treats an absent entry as
        // "left the cluster" and would delete the server outright, turning a
        // recoverable auth failure into a vanished row.
        if (token == null) {
          if (existing != null) {
            discovered.add(existing.copyWith(
              name: peer.name.isEmpty ? existing.name : peer.name,
              origin: ServerOrigin.cluster,
            ));
          }
          continue;
        }
        discovered.add(ServerConfig(
          // Keep the name we already had when the advertiser offers none, so a
          // re-mint never renames a server to its own URL.
          name: peer.name.isEmpty ? (existing?.name ?? url) : peer.name,
          baseUrl: url,
          bearerToken: token,
          origin: ServerOrigin.cluster,
        ));
      }

      return await _store.syncDiscovered(discovered);
    } finally {
      _running = false;
    }
  }

  /// Asks each server we can reach to obtain a token for [url], stopping at the
  /// first that succeeds. More than one peer may know it; only one needs to.
  Future<String?> _mintVia(List<ServerConfig> known, String url) async {
    for (final server in known) {
      if (_norm(server.baseUrl) == url) continue;
      try {
        final token = await _build(server)
            .requestClientToken(url: url, label: _label);
        if (token.isNotEmpty) return token;
      } catch (e) {
        debugPrint('[discovery] ${server.name} could not mint for $url: $e');
      }
    }
    return null;
  }

  static String _norm(String url) =>
      url.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();
}
