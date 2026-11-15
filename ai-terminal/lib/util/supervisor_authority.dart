// #466 - which configured server the Journal page reads the supervisor from.
//
// The supervisor runs on the lease authority only. The app does not know which server
// that is, so it asks every configured server `GET /api/supervisor/state` and reads the
// answers with ONE rule, here, pure:
//   * a server answering `role: authority` IS the supervisor (switched off when it says
//     `enabled: false`);
//   * otherwise a `role: peer` answer names the authority: the configured server of that
//     name (case-insensitive) is the supervisor - and when it did not answer, or is not
//     in this app's list, the page says exactly that;
//   * otherwise nobody has one: `role: none` is "no lease authority is configured"; a
//     server too old for the route (404) and a server that did not answer are each said
//     as what they are, never as "nothing to show".

import '../api/models.dart';
import '../api/supervisor_models.dart';

/// One server's answer to `GET /api/supervisor/state`: the parsed state, or the failure.
class SupervisorProbe {
  final SupervisorState? state;

  /// HTTP status of a failure (0 = transport); null when [state] is set.
  final int? status;
  final String? error;

  const SupervisorProbe.answered(SupervisorState this.state)
      : status = null,
        error = null;
  const SupervisorProbe.failed(int this.status, String this.error) : state = null;

  bool get answered => state != null;
}

enum SupervisorFindKind {
  /// [SupervisorFind.server] is the authority; [SupervisorFind.state] its answer.
  found,

  /// The authority answered, with its supervisor switched off.
  off,

  /// No server has a lease authority configured.
  noAuthority,

  /// A peer named the authority, and it did not answer (or answered as a non-authority).
  unreachable,

  /// A peer named the authority, and no configured server has that name.
  notListed,

  /// Every answering server is too old for the route.
  unsupported,

  /// No server answered at all (or none is configured).
  nobodyAnswered,
}

class SupervisorFind {
  final SupervisorFindKind kind;
  final ServerConfig? server;
  final SupervisorState? state;

  /// What the page says when there is no state to show.
  final String message;

  const SupervisorFind(this.kind, {this.server, this.state, this.message = ''});

  bool get found => kind == SupervisorFindKind.found;
}

/// Reads [probes] (keyed by [ServerConfig.baseUrl]; a server with no entry was not asked)
/// for [servers], in the configured order.
SupervisorFind findSupervisor(List<ServerConfig> servers, Map<String, SupervisorProbe> probes) {
  if (servers.isEmpty) {
    return const SupervisorFind(SupervisorFindKind.nobodyAnswered, message: 'No supervisor: no server is configured');
  }
  for (final sv in servers) {
    final st = probes[sv.baseUrl]?.state;
    if (st == null || !st.isAuthority) continue;
    if (!st.enabled) {
      return SupervisorFind(SupervisorFindKind.off,
          server: sv, state: st, message: 'No supervisor: it is switched off on ${sv.name}');
    }
    return SupervisorFind(SupervisorFindKind.found, server: sv, state: st);
  }
  for (final sv in servers) {
    final st = probes[sv.baseUrl]?.state;
    final name = st?.role == 'peer' ? st?.authorityName : null;
    if (name == null) continue;
    final want = name.toLowerCase();
    ServerConfig? match;
    for (final c in servers) {
      if (c.name.toLowerCase() == want) {
        match = c;
        break;
      }
    }
    if (match == null) {
      return SupervisorFind(SupervisorFindKind.notListed,
          message: "No supervisor here: its server ($name) is not in this app's server list");
    }
    final p = probes[match.baseUrl];
    final why = p == null
        ? 'it was not asked'
        : p.answered
            ? 'it does not answer as the supervisor'
            : p.error ?? 'no answer';
    return SupervisorFind(SupervisorFindKind.unreachable,
        server: match, message: "The supervisor's server ($name) is not reachable: $why");
  }
  final answers = [for (final sv in servers) ?probes[sv.baseUrl]];
  if (answers.any((p) => p.state?.role == 'none')) {
    return const SupervisorFind(SupervisorFindKind.noAuthority,
        message: 'No supervisor: no lease authority is configured');
  }
  if (answers.isNotEmpty && answers.every((p) => p.status == 404)) {
    return const SupervisorFind(SupervisorFindKind.unsupported,
        message: 'No supervisor: no server here is new enough to run one');
  }
  final failed = <String>[
    for (final sv in servers)
      if (probes[sv.baseUrl] case final p? when !p.answered) '${sv.name}: ${p.error}',
  ];
  return SupervisorFind(SupervisorFindKind.nobodyAnswered,
      message: failed.isEmpty ? 'No supervisor: no server answered' : 'No supervisor found: ${failed.join('; ')}');
}
