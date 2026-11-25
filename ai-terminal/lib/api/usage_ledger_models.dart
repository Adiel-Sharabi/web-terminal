// #529 - the usage ledger's wire shape: `GET /api/usage-ledger?cluster=1`. The SERVER owns
// every rule (what a week holds, how sessions rank, why each is big, which peer was skipped);
// this file only reads its answer. Every field is optional and every value tolerated: a
// missing or junk field reads as null/empty/0, never an exception, so a server one release
// older or newer cannot take the panel down. Nothing is guessed: an unknown is null.

String? _str(dynamic v) {
  if (v is! String) return null;
  final t = v.trim();
  return t.isEmpty ? null : t;
}

double _num(dynamic v) => v is num && v.isFinite ? v.toDouble() : 0;

int _int(dynamic v) => v is num && v.isFinite && v.abs() < 9e18 ? v.toInt() : 0;

Map<String, dynamic> _map(dynamic v) => v is Map<String, dynamic> ? v : const <String, dynamic>{};

List<T> _list<T>(dynamic v, T? Function(dynamic) parse) =>
    v is List ? List<T>.unmodifiable(v.map(parse).whereType<T>()) : List<T>.unmodifiable(const []);

DateTime? _at(dynamic v) {
  final s = _str(v);
  return s == null ? null : DateTime.tryParse(s)?.toLocal();
}

/// One finished or running week of usage (millions of weighted cost units: an estimate).
class UsageWeek {
  /// The Monday the week starts on, `YYYY-MM-DD`.
  final String weekOf;
  final int days;

  /// Days the roll-up does not hold yet (today): their units are the day so far.
  final int inProgressDays;
  final double unitsM;
  final double perDayM;
  final double subagentM;
  final double opusM;
  final int wakeCount;
  final double wakeM;

  const UsageWeek({
    required this.weekOf,
    this.days = 0,
    this.inProgressDays = 0,
    this.unitsM = 0,
    this.perDayM = 0,
    this.subagentM = 0,
    this.opusM = 0,
    this.wakeCount = 0,
    this.wakeM = 0,
  });

  bool get partial => inProgressDays > 0;

  /// Share of the week's units spent by subagents, 0..1; null for an empty week.
  double? get subagentShare => unitsM > 0 ? (subagentM / unitsM).clamp(0.0, 1.0) : null;

  static UsageWeek? fromJson(dynamic json) {
    final m = _map(json);
    final weekOf = _str(m['weekOf']);
    if (weekOf == null) return null;
    final wake = _map(m['wake']);
    return UsageWeek(
      weekOf: weekOf,
      days: _int(m['days']),
      inProgressDays: _int(m['inProgressDays']),
      unitsM: _num(m['unitsM']),
      perDayM: _num(m['perDayM']),
      subagentM: _num(m['subagentM']),
      opusM: _num(m['opusM']),
      wakeCount: _int(wake['n']),
      wakeM: _num(wake['unitsM']),
    );
  }
}

/// One reason a session is big, from the ledger's own lines: [code] is for the app's logic,
/// [text] is the server's sentence, [n] the number of windows it rests on.
class UsageWhy {
  final String code;
  final String text;
  final int n;

  const UsageWhy({required this.code, required this.text, this.n = 0});

  static UsageWhy? fromJson(dynamic json) {
    final m = _map(json);
    final text = _str(m['text']);
    if (text == null) return null;
    return UsageWhy(code: _str(m['code']) ?? 'unknown', text: text, n: _int(m['n']));
  }
}

/// What the check-in scan decided about a session (#540).
class UsageCheckIns {
  final int woken;
  final int skipped;
  final int told;
  final int handedOff;
  final int? maxCtxK;
  final int? maxIdleMin;

  const UsageCheckIns({this.woken = 0, this.skipped = 0, this.told = 0, this.handedOff = 0, this.maxCtxK, this.maxIdleMin});

  static UsageCheckIns? fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) return null;
    return UsageCheckIns(
      woken: _int(json['woken']),
      skipped: _int(json['skipped']),
      told: _int(json['told']),
      handedOff: _int(json['handedOff']),
      maxCtxK: json['maxCtxK'] is num ? _int(json['maxCtxK']) : null,
      maxIdleMin: json['maxIdleMin'] is num ? _int(json['maxIdleMin']) : null,
    );
  }
}

/// One ranked session: who burned the most, and why. Units are what the ledger's windows
/// credit it (a window names only its top 3), so they are a lower bound.
class UsageSession {
  /// The ledger's short id: the agent conversation's, or (a check-in row) the session's own.
  final String id;
  final String machine;
  final double unitsM;
  final int windows;
  final DateTime? firstAt;
  final DateTime? lastAt;
  final List<UsageWhy> why;

  /// The web-terminal session this row belongs to, while it exists on [machine]; else null.
  final String? sessionId;
  final String? name;
  final UsageCheckIns? checkIns;

  const UsageSession({
    required this.id,
    required this.machine,
    this.unitsM = 0,
    this.windows = 0,
    this.firstAt,
    this.lastAt,
    this.why = const [],
    this.sessionId,
    this.name,
    this.checkIns,
  });

  static UsageSession? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    if (id == null) return null;
    return UsageSession(
      id: id,
      machine: _str(m['machine']) ?? '',
      unitsM: _num(m['unitsM']),
      windows: _int(m['windows']),
      firstAt: _at(m['firstAt']),
      lastAt: _at(m['lastAt']),
      why: _list(m['why'], UsageWhy.fromJson),
      sessionId: _str(m['sessionId']),
      name: _str(m['name']),
      checkIns: UsageCheckIns.fromJson(m['checkIns']),
    );
  }
}

/// A peer the merge did not use, and why (an older server is not an error).
class UsageNote {
  final String machine;
  final String? reason;

  const UsageNote(this.machine, [this.reason]);
}

/// The whole report: one machine's, or - from `?cluster=1` - the cluster's.
class UsageLedger {
  final String machine;

  /// The machines the report covers; just [machine] when it is one machine's own.
  final List<String> machines;

  /// How many days back the ranked sessions look.
  final int days;

  /// Newest week first.
  final List<UsageWeek> weeks;
  final List<UsageSession> sessions;
  final int checkInsWoken;
  final int checkInsSkipped;
  final int checkInsTold;
  final int checkInsHandedOff;
  final int windows;
  final List<UsageNote> skipped;
  final List<String> unreachable;

  const UsageLedger({
    this.machine = '',
    this.machines = const [],
    this.days = 7,
    this.weeks = const [],
    this.sessions = const [],
    this.checkInsWoken = 0,
    this.checkInsSkipped = 0,
    this.checkInsTold = 0,
    this.checkInsHandedOff = 0,
    this.windows = 0,
    this.skipped = const [],
    this.unreachable = const [],
  });

  bool get isEmpty => weeks.isEmpty && sessions.isEmpty;

  int get checkInsTotal => checkInsWoken + checkInsSkipped + checkInsTold + checkInsHandedOff;

  static UsageLedger fromJson(dynamic json) {
    final m = _map(json);
    final total = _map(_map(m['checkIns'])['total']);
    final machine = _str(m['machine']) ?? '';
    final machines = _list<String>(m['machines'], _str);
    return UsageLedger(
      machine: machine,
      machines: machines.isEmpty && machine.isNotEmpty ? [machine] : machines,
      days: _int(m['days']) == 0 ? 7 : _int(m['days']),
      weeks: _list(m['weeks'], UsageWeek.fromJson),
      sessions: _list(m['sessions'], UsageSession.fromJson),
      checkInsWoken: _int(total['woken']),
      checkInsSkipped: _int(total['skipped']),
      checkInsTold: _int(total['told']),
      checkInsHandedOff: _int(total['handed-off']),
      windows: _int(_map(m['coverage'])['windows']),
      skipped: _list(m['skipped'], (e) {
        final x = _map(e);
        final name = _str(x['machine']);
        return name == null ? null : UsageNote(name, _str(x['reason']));
      }),
      unreachable: _list<String>(m['unreachable'], _str),
    );
  }
}
