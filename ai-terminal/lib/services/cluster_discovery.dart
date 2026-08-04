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

/// Builds a client for a server — injectable so tests never touch the network.
typedef ApiClientBuilder = ApiClient Function(ServerConfig server);

class ClusterDiscovery {
  ClusterDiscovery({
    required ServerStore store,
    ApiClientBuilder? clientBuilder,
    String deviceLabel = 'companion',
    // `this._store` is what the lint would prefer, but Dart forbids a PRIVATE
    // named parameter, so the field has to be assigned in the initializer list.
  })  : _build = clientBuilder ?? ApiClient.new,
        _label = deviceLabel,
        // ignore: prefer_initializing_formals
        _store = store;

  final ServerStore _store;
  final ApiClientBuilder _build;
  final String _label;

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
        if (existing != null && existing.origin == ServerOrigin.manual) continue;

        if (existing != null && existing.bearerToken.isNotEmpty) {
          // Known and usable — refresh the name, keep the token.
          discovered.add(existing.copyWith(
            name: peer.name.isEmpty ? existing.name : peer.name,
            origin: ServerOrigin.cluster,
          ));
          continue;
        }

        // New to us: we need a token before it is of any use.
        if (!peer.hasToken) continue; // the advertiser cannot vouch for it yet
        final token = await _mintVia(known, url);
        if (token == null) continue; // nobody could get us one; try again later
        discovered.add(ServerConfig(
          name: peer.name.isEmpty ? url : peer.name,
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
