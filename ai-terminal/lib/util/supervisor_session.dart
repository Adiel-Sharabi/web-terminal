// #466/#475 - the ONE way a supervisor screen (the Journal, the Supervisor) turns a session
// the authority names into a [Session] the app can open: by the configured server of that
// name, and only for an id the server minted (a node comes from the authority, and its id
// would ride another server's token in a URL).

import '../api/models.dart';

/// A session id as the server mints it.
final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);

/// The configured server named [name] (case-insensitive), or null.
ServerConfig? serverNamed(List<ServerConfig> servers, String? name) {
  if (name == null) return null;
  final want = name.toLowerCase();
  for (final s in servers) {
    if (s.name.toLowerCase() == want) return s;
  }
  return null;
}

/// The app's own row for session [id] on the server named [server] when [current] has it,
/// else one built from what the authority said ([name], [cwd], [status], [agent]), so
/// opening it paints at once. Null when the server is not in [servers] or [id] is not a
/// session id: nothing here could (or may) reach it.
Session? supervisedSession({
  required String id,
  required String? server,
  required List<ServerConfig> servers,
  required Iterable<Session> current,
  String? name,
  String? cwd,
  String? status,
  String? agent,
}) {
  final sv = serverNamed(servers, server);
  if (sv == null || !_uuid.hasMatch(id)) return null;
  for (final s in current) {
    if (s.id == id && s.server.baseUrl == sv.baseUrl) return s;
  }
  return Session.fromJson(sv, {
    'id': id,
    'name': name ?? id,
    'cwd': cwd ?? '',
    'status': status ?? 'idle',
    'agent': agent,
  });
}
