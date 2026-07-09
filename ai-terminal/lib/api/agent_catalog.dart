import 'api_client.dart';
import 'models.dart';

/// Cache of the server's AI-agent provider catalogue (`GET /api/agents`).
///
/// The server's registry (`lib/agents.js`) is the SINGLE source of truth for which
/// CLI agents exist and how each is named and tinted. The app must never carry its
/// own copy of that table: a agent added server-side has to appear in the picker and
/// the session chips **without an app release**, and two copies would drift.
///
/// Lookups are by the `agent` id a session reports. An id absent from the catalogue
/// (a newer provider this app has not fetched yet) simply yields `null`, and callers
/// fall back to showing the raw id — never a crash, never a hidden session.
class AgentCatalog {
  AgentCatalog._();

  /// The process-wide catalogue, mirroring [SessionRepository.instance]'s idiom.
  static final AgentCatalog instance = AgentCatalog._();

  final Map<String, AgentInfo> _byId = <String, AgentInfo>{};

  /// The provider for [id], or `null` when the catalogue has never seen it.
  AgentInfo? operator [](String? id) => id == null ? null : _byId[id];

  /// Every known provider, in insertion (server) order.
  List<AgentInfo> get all => List.unmodifiable(_byId.values);

  bool get isEmpty => _byId.isEmpty;

  /// Reload from [client]'s server. [ApiClient.agents] never throws — it yields an
  /// empty list on failure, and an empty result leaves the last-known catalogue in
  /// place rather than blanking every chip on one flaky request.
  Future<void> refresh(ApiClient client) async {
    final list = await client.agents();
    if (list.isEmpty) return;
    for (final a in list) {
      _byId[a.id] = a;
    }
  }

  /// Record one provider learned from any fetch (e.g. the New Session sheet's
  /// picker), so the session-list chips pick it up without a second round-trip.
  void adopt(AgentInfo agent) => _byId[agent.id] = agent;

  /// Test seam — drop everything the catalogue has learned.
  void clear() => _byId.clear();
}
