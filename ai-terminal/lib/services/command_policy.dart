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

/// One offered slash command (#188) — a button in the compose bar.
///
/// Every field is server-published. The client holds NO list of which commands
/// deserve a button, what they are called, or in what order they appear: that
/// table is `lib/commands.js`, and a copy here would be the third one (after the
/// server and `app.html`) and would drift the first time a command is added.
class QuickCommand {
  const QuickCommand({
    required this.name,
    required this.label,
    required this.lens,
    this.confirm,
  });

  /// The command without its slash, e.g. `compact`.
  final String name;

  /// What the button says, e.g. `Compact`.
  final String label;

  /// Where the user should stand while it runs — `chat` or `terminal`.
  final String lens;

  /// The question to ask BEFORE running it, or null for "just run it". Only the
  /// destructive command carries one, and the wording is server-owned so both
  /// clients say the same thing.
  final String? confirm;

  /// True when running this costs something that cannot be undone.
  bool get isDestructive => confirm != null;

  /// The text actually submitted. Kept here so the slash is added in ONE place.
  String get text => '/$name';

  static QuickCommand? fromJson(Map<String, dynamic> r) {
    final name = r['name'];
    if (name is! String || name.isEmpty) return null;
    final label = r['label'];
    final lens = r['lens'];
    final confirm = r['confirm'];
    return QuickCommand(
      name: name.toLowerCase(),
      // Fall back to the name rather than dropping the row: a server that adds a
      // command but forgets its label should still give the user the button.
      label: label is String && label.isNotEmpty ? label : name,
      lens: lens is String ? lens : 'chat',
      // `.trim()` matters: a whitespace-only string is NOT empty, so without it
      // a blank `confirm` would mark the command destructive and pop a dialog
      // with no question in it. Caught by its own unit test.
      confirm: confirm is String && confirm.trim().isNotEmpty ? confirm : null,
    );
  }
}

class CommandPolicy {
  CommandPolicy._();

  static final CommandPolicy instance = CommandPolicy._();

  /// The ordered button row, exactly as the server sent it (#188). Empty against
  /// a server older than #188 — which renders no buttons and changes nothing else.
  ///
  /// Deliberately NOT sorted here: the order is a decision `lib/commands.js`
  /// owns (the destructive row sorts last, away from a thumb), and re-sorting it
  /// client-side would be a second opinion on a published fact.
  final List<QuickCommand> _quick = [];

  List<QuickCommand> get quickCommands => List.unmodifiable(_quick);

  /// Server-published policy, keyed by command name without its leading slash.
  /// Empty until a fetch succeeds — [_fallback] covers that window and any
  /// server without the `command-policy` capability.
  final Map<String, String> _lensByName = {};
  bool _loaded = false;
  // A load is in progress. Separate from [_loaded] so a FAILED load does not
  // permanently disable the catalogue (see ensureLoaded).
  bool _inFlight = false;

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
  /// Returns true when the catalogue actually CHANGED, so a caller that renders
  /// from it knows to rebuild (#188).
  Future<bool> ensureLoaded(ApiClient api) async {
    if (_loaded || _inFlight) return false;
    // NOT `_loaded = true` here. `commandPolicy()` swallows every failure into
    // empty lists, so marking it loaded before the await meant ONE transient
    // network error left the client with no buttons and no lens policy for the
    // whole app run, with nothing to trigger a retry. `_inFlight` gives the same
    // protection against a concurrent second call without making failure sticky.
    _inFlight = true;
    final body = await api.commandPolicy();
    _inFlight = false;
    // An empty catalogue is what a failure looks like AND what a server older
    // than #131 legitimately returns. Treat it as "not loaded" either way: the
    // fallback table already covers the old server, and leaving the door open
    // costs one retry on the next session screen.
    final rows = body['commands'] ?? const <Map<String, dynamic>>[];
    final quick = body['quick'] ?? const <Map<String, dynamic>>[];
    if (rows.isEmpty && quick.isEmpty) return false;
    _loaded = true;
    for (final r in rows) {
      final name = r['name'], lens = r['lens'];
      if (name is String && lens is String) _lensByName[name.toLowerCase()] = lens;
    }
    _quick
      ..clear()
      ..addAll(
        quick
            .map(QuickCommand.fromJson)
            .whereType<QuickCommand>(),
      );
    return true;
  }

  /// Test seam — resets the cache so a spec can drive a specific policy.
  void debugReset([Map<String, String>? seed, List<QuickCommand>? quick]) {
    _lensByName
      ..clear()
      ..addAll(seed ?? const {});
    _quick
      ..clear()
      ..addAll(quick ?? const []);
    _loaded = seed != null;
  }
}
