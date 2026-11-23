// #466/#492 - the ONE probe of the cluster for its supervisor: ask every configured server
// `GET /api/supervisor/state` and read the answers with [findSupervisor]. The Journal page
// and the questions inbox both ask through here, so they can never disagree about which
// server is the supervisor or why none is found.

import '../api/api_client.dart';
import '../api/models.dart';
import '../util/supervisor_authority.dart';

/// Asks every one of [servers] (through [client]) for its supervisor state, in parallel,
/// and reads the answers. A server that fails is that server's answer, never an exception.
Future<SupervisorFind> askSupervisor(List<ServerConfig> servers, ApiClient Function(ServerConfig) client) async {
  final probes = <String, SupervisorProbe>{};
  await Future.wait(servers.map((sv) async {
    try {
      probes[sv.baseUrl] = SupervisorProbe.answered(await client(sv).supervisorState());
    } on ApiException catch (e) {
      probes[sv.baseUrl] = SupervisorProbe.failed(e.status, e.message);
    } catch (e) {
      // Not swallowed: it is this server's answer, said on the page like any failure.
      probes[sv.baseUrl] = SupervisorProbe.failed(0, 'unreadable answer ($e)');
    }
  }));
  return findSupervisor(servers, probes);
}
