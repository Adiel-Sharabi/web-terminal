// Template for the gitignored `spike_config.dart`.
//
// `server_store.dart` imports `spike_config.dart` for an optional seed server
// list, so the app does not compile — and `flutter test` cannot run — until that
// file exists. It is gitignored because a real one contains server URLs and
// **bearer tokens**, which must never be committed.
//
// To work on the companion:
//
//     cp lib/spike_config.example.dart lib/spike_config.dart
//
// Empty values are a fully supported path: `server_store.dart` checks
// `kSeedServers.isNotEmpty` and returns no servers when `kServerBase` or
// `kBearerToken` is blank, so the app simply starts with an empty server list
// and you add servers through the UI. Fill these in only if you want a machine
// to come up pre-pointed at your own servers.

/// Servers to pre-populate on first launch. Leave empty to start with none.
const kSeedServers = <Map<String, String>>[
  // {'name': 'Home', 'baseUrl': 'https://your-host.example', 'bearerToken': '…'},
];

/// Legacy single-server seed, used only when [kSeedServers] is empty.
const kServerBase = '';
const kBearerToken = '';
