/// App-wide server configuration.
///
/// A thin facade over [ServerStore], which owns the persisted, user-editable
/// server list (SharedPreferences, seeded on first run from the gitignored
/// `spike_config.dart` constants). This class keeps the historical
/// `AppConfig.servers` / `AppConfig.updateServerName` surface so existing
/// callers (the session repository, screens, push service) are unaffected, and
/// adds [serversStream] for listeners that must react to add/remove.
library;

import '../api/models.dart';
import 'server_store.dart';

/// Holds the list of configured servers for the running app.
class AppConfig {
  /// The configured servers, read live from [ServerStore]. Unmodifiable — mutate
  /// via [ServerStore.instance] (`add` / `update` / `removeAt` / `setAll`).
  static List<ServerConfig> get servers => ServerStore.instance.servers;

  /// Broadcast stream of the server list; emits whenever a server is added,
  /// removed, updated or renamed. Replays the current value to new listeners.
  static Stream<List<ServerConfig>> get serversStream =>
      ServerStore.instance.changes;

  /// Upgrades the cached display name for the server whose base URL matches
  /// [baseUrl] (called after a successful `/api/version`), persisting it via
  /// [ServerStore] so the resolved name sticks. No-op if [name] is empty or no
  /// server matches.
  static void updateServerName(String baseUrl, String name) =>
      ServerStore.instance.updateServerName(baseUrl, name);
}
