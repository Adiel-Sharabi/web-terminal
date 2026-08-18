/// Where the user should stand while a slash command runs (#131).
///
/// The server owns the classification (`lib/commands.js`, published at
/// `GET /api/commands`) so adding or reclassifying a command needs no client
/// release — the same arrangement `/api/agents` uses for the agent catalogue.
/// This class is the client's cache of that answer plus the fallback for a
/// server too old to publish it.
///
/// WHY THERE IS A POLICY AT ALL. Measured across the 609 Claude transcripts on
/// the reporting machine, slash commands divide by WHAT THEY WRITE:
///
///   * a skill (`/issue`, `/goal`, …) writes a real user turn and a full agent
///     turn — the chat lens renders it completely, so Chat is the right place;
///   * `/compact` writes a `compact_boundary` system line and drives a
///     server-published `compacting` flag (#65/#115/#129) — Chat has both state
///     and an indicator;
///   * `/status`, `/usage` and the other built-in dialogs write a `local_command`
///     system line whose ENTIRE recorded result is the literal string
///     "Settings dialog dismissed". The panel and the numbers are TUI paint and
///     reach no turn at all, so leaving the user in Chat strands them looking at
///     an invocation with no answer — the reported bug.
///
/// The default is Chat because the open-ended class (everything not a built-in)
/// is skills, and a skill always starts a real turn.
library;

import '../api/api_client.dart';

class CommandPolicy {
  CommandPolicy._();

  static final CommandPolicy instance = CommandPolicy._();

  /// Server-published policy, keyed by command name without its leading slash.
  /// Empty until a fetch succeeds — [_fallback] covers that window and any
  /// server without the `command-policy` capability.
  final Map<String, String> _lensByName = {};
  bool _loaded = false;

  /// Claude's own built-ins whose whole result is TUI paint. Mirrors the server
  /// table, and exists ONLY so an older server (or a failed fetch) still gets
  /// the reported bug fixed. The server copy is authoritative: a name published
  /// there overrides this, and a name only here still works.
  static const Set<String> _fallback = {
    'status', 'usage', 'context', 'cost', 'doctor', 'model',
    'login', 'logout', 'config', 'help', 'exit', 'quit', 'clear',
  };

  /// The command name in [text], lower-cased, without its slash or arguments.
  /// Namespaced skills (`/caveman:caveman`) keep their full name.
  static String nameOf(String text) {
    final m = RegExp(r'^\s*/([^\s]*)').firstMatch(text);
    return m == null ? '' : m.group(1)!.toLowerCase();
  }

  /// True when this command's result exists ONLY as terminal paint, so the user
  /// must stay in the Terminal lens to read it.
  bool pinsTerminal(String text) {
    final name = nameOf(text);
    if (name.isEmpty) return false;
    final published = _lensByName[name];
    if (published != null) return published == 'terminal';
    return _fallback.contains(name);
  }

  /// Loads the policy once per app run. Best-effort by design: a failure leaves
  /// [_fallback] in charge rather than throwing, because a slash command must
  /// keep working against any server.
  Future<void> ensureLoaded(ApiClient api) async {
    if (_loaded) return;
    _loaded = true;
    final rows = await api.commandPolicy();
    for (final r in rows) {
      final name = r['name'], lens = r['lens'];
      if (name is String && lens is String) _lensByName[name.toLowerCase()] = lens;
    }
  }

  /// Test seam — resets the cache so a spec can drive a specific policy.
  void debugReset([Map<String, String>? seed]) {
    _lensByName
      ..clear()
      ..addAll(seed ?? const {});
    _loaded = seed != null;
  }
}
