// #507 - Mission Control's wire shapes (`/api/mc/*`, the contract in
// `docs/mission-control.md`), as the companion reads them.
//
// The SERVER owns every rule here - which card ranks first and why, what a project's
// counts are, which server answers - and this file only reads its answer. Every field is
// optional and every value is tolerated: a missing or junk field reads as null/empty/0,
// never an exception, because the routes are new and a server one release older or newer
// must not take the screen down with it. Nothing is guessed: an unknown is null and the
// screen says it does not know.

import 'models.dart' show BriefDecision;

String? _str(dynamic v) {
  if (v is! String) return null;
  final t = v.trim();
  return t.isEmpty ? null : t;
}

int? _int(dynamic v) => v is int ? v : (v is num && v.isFinite && v.abs() < 9e18 ? v.toInt() : null);

int _count(dynamic v) {
  final n = _int(v);
  return n == null || n < 0 ? 0 : n;
}

bool _bool(dynamic v) => v == true;

Map<String, dynamic> _map(dynamic v) => v is Map<String, dynamic> ? v : const <String, dynamic>{};

List<T> _list<T>(dynamic v, T? Function(dynamic) parse) =>
    v is List ? List<T>.unmodifiable(v.map(parse).whereType<T>()) : List<T>.unmodifiable(const []);

/// The largest instant [DateTime] can hold; beyond it the constructor throws.
const int _maxMs = 8640000000000000;

DateTime? _at(dynamic v) {
  final ms = _int(v);
  return ms == null || ms <= 0 || ms > _maxMs ? null : DateTime.fromMillisecondsSinceEpoch(ms);
}

/// A `409 {role: 'peer', authority: {name, url}}` answer: this server is not the one that
/// computes Mission Control, and it names the one that does.
class McAuthority {
  final String? name;
  final String? url;
  const McAuthority({this.name, this.url});

  /// The authority a 409 body names, or null when the body is not a peer answer.
  static McAuthority? fromPeerAnswer(dynamic json) {
    final m = _map(json);
    if (m['role'] != 'peer') return null;
    final a = m['authority'];
    if (a is String) return McAuthority(name: _str(a));
    final am = _map(a);
    return McAuthority(name: _str(am['name']), url: _str(am['url']));
  }

  /// What the screen calls it: its name, else its url, else "another server".
  String get label => name ?? url ?? 'another server';
}

/// One count row (`Counts` in the contract). [stages] is the subjects per progress stage,
/// IN THE SERVER'S ORDER (the server owns the order, `lib/mc-stage.js`); empty when the
/// server does not send it.
class McCounts {
  final int active;
  final int needsYou;
  final int waitsOnOthers;
  final int doneWeek;
  final int sessions;
  final List<McStageCount> stages;

  const McCounts({
    this.active = 0,
    this.needsYou = 0,
    this.waitsOnOthers = 0,
    this.doneWeek = 0,
    this.sessions = 0,
    this.stages = const [],
  });

  static McCounts fromJson(dynamic json) {
    final m = _map(json);
    final raw = m['stages'];
    List<McStageCount> stages;
    if (raw is List) {
      stages = _list(raw, McStageCount.fromJson);
    } else if (raw is Map) {
      // A map keeps the server's insertion order in Dart's decoder.
      stages = List.unmodifiable([
        for (final e in raw.entries)
          if (e.key is String && (e.key as String).trim().isNotEmpty) McStageCount((e.key as String).trim(), _count(e.value)),
      ]);
    } else {
      stages = const [];
    }
    return McCounts(
      active: _count(m['active']),
      needsYou: _count(m['needsYou']),
      waitsOnOthers: _count(m['waitsOnOthers']),
      doneWeek: _count(m['doneWeek']),
      sessions: _count(m['sessions']),
      stages: stages,
    );
  }

  /// The subjects the stage bar spans.
  int get stageTotal => stages.fold(0, (a, s) => a + s.count);
}

class McStageCount {
  final String stage;
  final String? label;
  final int count;
  const McStageCount(this.stage, this.count, [this.label]);

  static McStageCount? fromJson(dynamic json) {
    final m = _map(json);
    final stage = _str(m['stage']);
    if (stage == null) return null;
    return McStageCount(stage, _count(m['count']), _str(m['label']));
  }

  /// What the bar's legend says: the server's label, else the stage id made readable.
  String get name => label ?? stage.replaceAll('-', ' ');
}

class McArea {
  final String id;
  final String name;
  final McCounts counts;
  const McArea({required this.id, required this.name, this.counts = const McCounts()});

  static McArea? fromJson(dynamic json) {
    final m = _map(json);
    final name = _str(m['name']) ?? _str(m['id']);
    if (name == null) return null;
    return McArea(id: _str(m['id']) ?? name, name: name, counts: McCounts.fromJson(m['counts']));
  }
}

class McProject {
  final String id;
  final String name;

  /// `github owner/repo`, `ado Project`, or null.
  final String? trackerLabel;
  final List<McArea> areas;
  final McCounts counts;

  const McProject({required this.id, required this.name, this.trackerLabel, this.areas = const [], this.counts = const McCounts()});

  static McProject? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    final name = _str(m['name']) ?? id;
    if (name == null) return null;
    final t = _map(m['tracker']);
    final kind = _str(t['kind']);
    final where = _str(t['repo']) ?? _str(t['project']);
    return McProject(
      id: id ?? name,
      name: name,
      trackerLabel: where == null ? null : (kind == 'ado' ? 'ADO $where' : where),
      areas: _list(m['areas'], McArea.fromJson),
      counts: McCounts.fromJson(m['counts']),
    );
  }
}

/// A session a card blocks, by name.
class McSessionRef {
  final String? server;
  final String? id;
  final String? name;
  const McSessionRef({this.server, this.id, this.name});

  static McSessionRef? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    final name = _str(m['name']);
    if (id == null && name == null) return null;
    return McSessionRef(server: _str(m['server']), id: id, name: name);
  }
}

/// Why a card ranks where it does (`why` in the contract). [text] is the server's own
/// sentence ("blocks 3 sessions"); the screen shows it as is.
class McWhy {
  final int blocks;
  final List<McSessionRef> blockedSessions;
  final int? severity;
  final int? ageMin;
  final String? text;
  const McWhy({this.blocks = 0, this.blockedSessions = const [], this.severity, this.ageMin, this.text});

  static McWhy fromJson(dynamic json) {
    final m = _map(json);
    return McWhy(
      blocks: _count(m['blocks']),
      blockedSessions: _list(m['blockedSessions'], McSessionRef.fromJson),
      severity: _int(m['severity']),
      ageMin: _int(m['ageMin']),
      text: _str(m['text']),
    );
  }
}

/// One "Answer now" card: a session stuck on the person. The server ranks them; [rank]
/// and the list order are its answer.
class McCard {
  final String id;

  /// `question`, `permission`, `decision`, `wait` - or any newer kind, kept as sent.
  final String kind;
  final String? server;
  final String? serverUrl;
  final String? sessionId;
  final String? sessionName;
  final String? project;
  final String? subjectKey;
  final String? ref;
  final String? title;
  final String? what;
  final McWhy why;
  final int? rank;
  final DateTime? askedAt;
  final BriefDecision? decision;
  final bool hasQuestion;

  const McCard({
    required this.id,
    this.kind = 'wait',
    this.server,
    this.serverUrl,
    this.sessionId,
    this.sessionName,
    this.project,
    this.subjectKey,
    this.ref,
    this.title,
    this.what,
    this.why = const McWhy(),
    this.rank,
    this.askedAt,
    this.decision,
    this.hasQuestion = false,
  });

  /// Null when it has no id: a card that cannot be addressed cannot be parked or answered.
  static McCard? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    if (id == null) return null;
    return McCard(
      id: id,
      kind: _str(m['kind']) ?? 'wait',
      server: _str(m['server']),
      serverUrl: _str(m['serverUrl']),
      sessionId: _str(m['sessionId']),
      sessionName: _str(m['sessionName']),
      project: _str(m['project']),
      subjectKey: _str(m['subjectKey']),
      ref: _str(m['ref']),
      title: _str(m['title']),
      what: _str(m['what']),
      why: McWhy.fromJson(m['why']),
      rank: _int(m['rank']),
      askedAt: _at(m['askedAt']),
      decision: BriefDecision.fromJson(m['decision']),
      hasQuestion: _bool(m['hasQuestion']),
    );
  }

  /// Answered in the questions inbox, which takes every kind of wait on the person (a
  /// question, a permission, a decision, a reported wait: #383) - so any card with a session.
  bool get answerable => sessionId != null;
}

/// One "My to-do" entry: a hands-on thing for the desk, parked by its session.
class McTodo {
  final String id;
  final String? cardId;
  final String? subjectKey;
  final String? ref;
  final String? title;
  final String? project;
  final String? text;
  final String? server;
  final String? sessionId;
  final DateTime? createdAt;
  final DateTime? doneAt;

  const McTodo({
    required this.id,
    this.cardId,
    this.subjectKey,
    this.ref,
    this.title,
    this.project,
    this.text,
    this.server,
    this.sessionId,
    this.createdAt,
    this.doneAt,
  });

  static McTodo? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    if (id == null) return null;
    return McTodo(
      id: id,
      cardId: _str(m['cardId']),
      subjectKey: _str(m['subjectKey']),
      ref: _str(m['ref']),
      title: _str(m['title']),
      project: _str(m['project']),
      text: _str(m['text']),
      server: _str(m['server']),
      sessionId: _str(m['sessionId']),
      createdAt: _at(m['createdAt']),
      doneAt: _at(m['doneAt']),
    );
  }

  bool get done => doneAt != null;
}

/// "Moving on its own": sessions working or idle with nothing owed to the person.
class McMoving {
  final int working;
  final int idle;
  final int total;
  const McMoving({this.working = 0, this.idle = 0, this.total = 0});

  static McMoving fromJson(dynamic json) {
    final m = _map(json);
    return McMoving(working: _count(m['working']), idle: _count(m['idle']), total: _count(m['total']));
  }
}

/// `GET /api/mc/now`.
class McNow {
  final List<McCard> answerNow;
  final List<McTodo> todo;
  final McMoving moving;
  final List<McProject> projects;
  final DateTime? generatedAt;

  const McNow({
    this.answerNow = const [],
    this.todo = const [],
    this.moving = const McMoving(),
    this.projects = const [],
    this.generatedAt,
  });

  static McNow fromJson(dynamic json) {
    final m = _map(json);
    return McNow(
      answerNow: _list(m['answerNow'], McCard.fromJson),
      todo: _list(m['todo'], McTodo.fromJson),
      moving: McMoving.fromJson(m['moving']),
      projects: _list(m['projects'], McProject.fromJson),
      generatedAt: _at(m['generatedAt']),
    );
  }
}

/// `GET /api/mc/projects`.
class McProjects {
  final List<McProject> projects;
  final DateTime? generatedAt;
  const McProjects({this.projects = const [], this.generatedAt});

  static McProjects fromJson(dynamic json) {
    final m = _map(json);
    return McProjects(projects: _list(m['projects'], McProject.fromJson), generatedAt: _at(m['generatedAt']));
  }
}

/// `POST /api/mc/todo`: the recorded to-do and whether the park message reached the
/// session. [refused] is the server's reason when it did not.
class McTodoResult {
  final McTodo? todo;
  final bool delivered;
  final String? refused;
  const McTodoResult({this.todo, this.delivered = false, this.refused});

  static McTodoResult fromJson(dynamic json) {
    final m = _map(json);
    final parked = _map(m['parked']);
    final refused = parked['refused'];
    return McTodoResult(
      todo: McTodo.fromJson(m['todo']),
      delivered: _bool(parked['delivered']),
      refused: refused is String ? _str(refused) : (refused == true ? 'refused' : null),
    );
  }
}
