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

/// What became of a to-do's park message (#506): `sending`, `delivered`, `refused` (the
/// session's gates said no; [reason] says why in plain words, and only the person sends it
/// again), `uncertain` (it may have landed; never sent again) or `none` (a prompt on its
/// screen: never sent; [reason] says so). The server's words.
class McPark {
  final String? state;
  final String? refused;
  final String? reason;
  final DateTime? at;
  const McPark({this.state, this.refused, this.reason, this.at});

  static McPark fromJson(dynamic json) {
    final m = _map(json);
    return McPark(state: _str(m['state']), refused: _str(m['refused']), reason: _str(m['reason']), at: _at(m['at']));
  }

  /// The session was not told, and the person may ask again.
  bool get isRefused => state == 'refused';

  /// The session was not told, and why ([reason]): a refusal, or a prompt on its screen.
  bool get notSent => state == 'refused' || state == 'none';

  /// It may have reached the session (no answer came, or none yet).
  bool get maybeSent => state == 'uncertain' || state == 'sending';
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
  final String? sessionName;
  final McPark park;

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
    this.sessionName,
    this.park = const McPark(),
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
      sessionName: _str(m['sessionName']),
      park: McPark.fromJson(m['park']),
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

/// `POST /api/mc/todo` (and a to-do's `park` retry): the recorded to-do and whether the
/// park message reached the session. [refused] is why it did not, in the server's plain
/// words when it sends them (`reason`), else its code; [uncertain]: it may have landed;
/// [already]: the card was moved before, so nothing was sent this time.
class McTodoResult {
  final McTodo? todo;
  final bool delivered;
  final String? refused;
  final bool uncertain;
  final bool already;
  const McTodoResult({this.todo, this.delivered = false, this.refused, this.uncertain = false, this.already = false});

  static McTodoResult fromJson(dynamic json) {
    final m = _map(json);
    final parked = _map(m['parked']);
    final refused = parked['refused'];
    return McTodoResult(
      todo: McTodo.fromJson(m['todo']),
      delivered: _bool(parked['delivered']),
      refused: _str(parked['reason']) ?? (refused is String ? _str(refused) : (refused == true ? 'refused' : null)),
      uncertain: _bool(parked['uncertain']),
      already: _bool(parked['already']),
    );
  }
}

// --- #508 / #509: subjects, their stage, sessions and runs ----------------------------

List<String> _strings(dynamic v) =>
    v is List ? List<String>.unmodifiable(v.map(_str).whereType<String>()) : const <String>[];

/// [items] with only the first of each [id]: a repeated id in junk data would give two
/// sibling widgets the same key.
List<T> _firstOf<T>(List<T> items, String Function(T) id) {
  final seen = <String>{};
  return List<T>.unmodifiable(items.where((x) => seen.add(id(x))));
}

/// The progress stages in order, as the contract lists them (`docs/mission-control.md`,
/// Stage; the server owns the order in `lib/mc-stage.js`, and the wire carries no copy of
/// it). A stage outside it is shown by its name, never dropped.
const List<String> kMcStageOrder = [
  'triage',
  'reproduced',
  'planned',
  'fixing',
  'pr-open',
  'in-review',
  'merged',
  'tested',
];

/// A stage id made readable: `pr-open` -> `PR open`.
String mcStageLabel(String stage) => switch (stage) {
      'pr-open' => 'PR open',
      'in-review' => 'In review',
      _ => stage.isEmpty ? stage : '${stage[0].toUpperCase()}${stage.substring(1).replaceAll('-', ' ')}',
    };

/// A pull request linked to a work item.
class McPr {
  final String? url;
  final int? number;
  final String? repo;

  /// `open`, `merged`, `closed`, or null (unknown).
  final String? state;
  final bool draft;
  const McPr({this.url, this.number, this.repo, this.state, this.draft = false});

  static McPr? fromJson(dynamic json) {
    final m = _map(json);
    final url = _str(m['url']);
    final number = _int(m['number']);
    if (url == null && number == null) return null;
    return McPr(url: url, number: number, repo: _str(m['repo']), state: _str(m['state']), draft: _bool(m['draft']));
  }

  String get label => [
        number == null ? 'PR' : 'PR #$number',
        if (draft) 'draft' else ?state,
      ].join(' ');
}

/// What the tracker says about a work item (`Meta` in the contract, #502).
class McMeta {
  final String? key;
  final String? ref;

  /// `github`, `ado`, or null.
  final String? tracker;
  final String? url;
  final String? title;
  final String? type;
  final String? state;
  final bool closed;

  /// 1 = highest; null when the tracker has none.
  final int? severity;

  /// The tracker's own severity text (`2 - High`), or null.
  final String? severityText;
  final int? priority;
  final String? createdBy;
  final DateTime? createdAt;
  final String? assignee;
  final String? area;
  final List<String> labels;
  final List<McPr> prs;

  /// A one-line summary, when the server sends one (the contract has none yet).
  final String? summary;
  final DateTime? staleSince;
  final String? error;
  final String? warning;

  const McMeta({
    this.key,
    this.ref,
    this.tracker,
    this.url,
    this.title,
    this.type,
    this.state,
    this.closed = false,
    this.severity,
    this.severityText,
    this.priority,
    this.createdBy,
    this.createdAt,
    this.assignee,
    this.area,
    this.labels = const [],
    this.prs = const [],
    this.summary,
    this.staleSince,
    this.error,
    this.warning,
  });

  static McMeta? fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) return null;
    final m = json;
    return McMeta(
      key: _str(m['key']),
      ref: _str(m['ref']),
      tracker: _str(m['tracker']),
      url: _str(m['url']),
      title: _str(m['title']),
      type: _str(m['type']),
      state: _str(m['state']),
      closed: _bool(m['closed']),
      severity: _int(m['severity']),
      severityText: _str(m['severityText']),
      priority: _int(m['priority']),
      createdBy: _str(m['createdBy']),
      createdAt: _at(m['createdAt']),
      assignee: _str(m['assignee']),
      area: _str(m['area']),
      labels: _strings(m['labels']),
      prs: _list(m['prs'], McPr.fromJson),
      summary: _str(m['summary']),
      staleSince: _at(m['staleSince']),
      error: _str(m['error']),
      warning: _str(m['warning']),
    );
  }

  /// What a row says about severity: the tracker's text, else `severity N`, else null.
  String? get severityLabel => severityText ?? (severity == null ? null : 'severity $severity');
}

/// One step a subject reached, and what showed it (`history[]` in `Stage`).
class McStageStep {
  final String stage;
  final DateTime? at;

  /// `report`, `pr`, `tracker`, or a newer source kept as sent.
  final String? source;
  final String? detail;
  const McStageStep({required this.stage, this.at, this.source, this.detail});

  static McStageStep? fromJson(dynamic json) {
    final m = _map(json);
    final stage = _str(m['stage']);
    if (stage == null) return null;
    return McStageStep(stage: stage, at: _at(m['at']), source: _str(m['source']), detail: _str(m['detail']));
  }
}

/// A subject's progress (`Stage`, #505): the server's [current] (max of reported and
/// evidence), each half, and the history of steps reached.
class McStage {
  final String? current;
  final String? reported;
  final String? evidence;
  final List<McStageStep> history;
  const McStage({this.current, this.reported, this.evidence, this.history = const []});

  static McStage fromJson(dynamic json) {
    final m = _map(json);
    return McStage(
      current: _str(m['current']),
      reported: _str(m['reported']),
      evidence: _str(m['evidence']),
      history: _list(m['history'], McStageStep.fromJson),
    );
  }

  /// The steps the history records for [stage], in the order sent.
  List<McStageStep> stepsFor(String stage) => [for (final s in history) if (s.stage == stage) s];
}

/// A session's latest report on a subject.
class McReportLine {
  final String? state;
  final String? stage;
  final String? note;
  final String? headline;
  final DateTime? at;
  const McReportLine({this.state, this.stage, this.note, this.headline, this.at});

  static McReportLine? fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) return null;
    final r = McReportLine(
      state: _str(json['state']),
      stage: _str(json['stage']),
      note: _str(json['note']),
      headline: _str(json['headline']),
      at: _at(json['at']),
    );
    return r.state == null && r.stage == null && r.note == null && r.headline == null ? null : r;
  }

  /// The one line the screen shows: the note, else the headline.
  String? get line => note ?? headline;
}

/// What a session waits on (`{on, what}`).
class McWait {
  final String on;
  final String? what;
  const McWait(this.on, [this.what]);

  static McWait? fromJson(dynamic json) {
    final m = _map(json);
    final on = _str(m['on']);
    return on == null ? null : McWait(on, _str(m['what']));
  }
}

/// A session on a subject (`SessionRef` in the contract). [parentId] is the SERVER's tree
/// answer: the screens draw it and never re-derive it.
class McSubjectSession {
  final String id;
  final String? server;
  final String? serverUrl;
  final String? name;
  final String? parentId;
  final String? status;
  final bool closed;
  final DateTime? closedAt;
  final McReportLine? lastReport;
  final McWait? wait;

  const McSubjectSession({
    required this.id,
    this.server,
    this.serverUrl,
    this.name,
    this.parentId,
    this.status,
    this.closed = false,
    this.closedAt,
    this.lastReport,
    this.wait,
  });

  static McSubjectSession? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    if (id == null) return null;
    return McSubjectSession(
      id: id,
      server: _str(m['server']),
      serverUrl: _str(m['serverUrl']),
      name: _str(m['name']),
      parentId: _str(m['parentId']),
      status: _str(m['status']),
      closed: _bool(m['closed']),
      closedAt: _at(m['closedAt']),
      lastReport: McReportLine.fromJson(m['lastReport']),
      wait: McWait.fromJson(m['wait']),
    );
  }

  String get label => name ?? id;
}

/// A child session of a run.
class McRunChild {
  final String? server;
  final String? id;
  final String? name;
  final String? status;
  const McRunChild({this.server, this.id, this.name, this.status});

  static McRunChild? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    final name = _str(m['name']);
    if (id == null && name == null) return null;
    return McRunChild(server: _str(m['server']), id: id, name: name, status: _str(m['status']));
  }
}

/// A run: one orchestrator session whose children work on several subjects (`Run`).
class McRun {
  final String id;
  final String? server;
  final String? sessionId;
  final String? name;
  final DateTime? startedAt;
  final String? status;
  final List<String> subjects;
  final List<McRunChild> children;

  const McRun({
    required this.id,
    this.server,
    this.sessionId,
    this.name,
    this.startedAt,
    this.status,
    this.subjects = const [],
    this.children = const [],
  });

  static McRun? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['id']);
    if (id == null) return null;
    return McRun(
      id: id,
      server: _str(m['server']),
      sessionId: _str(m['sessionId']),
      name: _str(m['name']),
      startedAt: _at(m['startedAt']),
      status: _str(m['status']),
      subjects: _strings(m['subjects']),
      children: _list(m['children'], McRunChild.fromJson),
    );
  }
}

/// The Project screen's filters. [key] is the `Counts` field the server counts it under.
enum McSubjectFilter {
  active('active', 'Everything active'),
  needsYou('needsYou', 'Needs you'),
  waitsOnOthers('waitsOnOthers', 'Waits on others'),
  doneWeek('doneWeek', 'Done this week');

  const McSubjectFilter(this.key, this.label);
  final String key;
  final String label;

  /// The server's count for this filter in [c].
  int countIn(McCounts c) => switch (this) {
        active => c.active,
        needsYou => c.needsYou,
        waitsOnOthers => c.waitsOnOthers,
        doneWeek => c.doneWeek,
      };
}

/// One work item, gathered across every server (`Subject` in the contract).
class McSubject {
  final String key;
  final String? ref;
  final String? url;
  final String? title;
  final String? project;
  final String? area;
  final McMeta? meta;
  final McStage stage;
  final List<McSubjectSession> sessions;
  final McCard? needsYou;

  /// `you`, `self`, `external`, `done`, or null.
  final String? waitsOn;
  final String? runId;
  final DateTime? updatedAt;

  /// The `Counts` keys the server counts this subject under (`buckets`). NOT in the
  /// contract yet - asked of the subjects lane (#504) so the filters and the counts are
  /// one server rule; read when sent, else null (see [inFilter]).
  final List<String>? buckets;

  const McSubject({
    required this.key,
    this.ref,
    this.url,
    this.title,
    this.project,
    this.area,
    this.meta,
    this.stage = const McStage(),
    this.sessions = const [],
    this.needsYou,
    this.waitsOn,
    this.runId,
    this.updatedAt,
    this.buckets,
  });

  static McSubject? fromJson(dynamic json) {
    final m = _map(json);
    final key = _str(m['key']);
    if (key == null) return null;
    return McSubject(
      key: key,
      ref: _str(m['ref']),
      url: _str(m['url']),
      title: _str(m['title']),
      project: _str(m['project']),
      area: _str(m['area']),
      meta: McMeta.fromJson(m['meta']),
      stage: McStage.fromJson(m['stage']),
      sessions: _firstOf(_list(m['sessions'], McSubjectSession.fromJson), (s) => s.id),
      needsYou: McCard.fromJson(m['needsYou']),
      waitsOn: _str(m['waitsOn']),
      runId: _str(m['runId']),
      updatedAt: _at(m['updatedAt']),
      buckets: m['buckets'] is List ? _strings(m['buckets']) : null,
    );
  }

  /// The ref the screen shows: [ref], else the key.
  String get refLabel => ref ?? key;

  /// What the screen calls it: the title, else the ref.
  String get titleLabel => title ?? meta?.title ?? refLabel;

  /// Whether the subject belongs under [f]. The server's [buckets] decide when sent.
  /// Until the contract carries them this is a CLIENT-SIDE reading of the subject's own
  /// fields, so a filter's rows can differ from the server's count beside it: a card or a
  /// `you` wait needs you; an `external` wait waits on others; a `done` wait or a closed
  /// work item is done, and done THIS WEEK when it last changed within 7 days of [now]
  /// (unknown when it changed: not this week); everything not done is active.
  bool inFilter(McSubjectFilter f, {DateTime? now}) {
    final b = buckets;
    if (b != null) return b.contains(f.key);
    final done = waitsOn == 'done' || (meta?.closed ?? false);
    return switch (f) {
      McSubjectFilter.active => !done,
      McSubjectFilter.needsYou => needsYou != null || waitsOn == 'you',
      McSubjectFilter.waitsOnOthers => waitsOn == 'external',
      McSubjectFilter.doneWeek => done && _withinWeek(updatedAt, now ?? DateTime.now()),
    };
  }

  static bool _withinWeek(DateTime? at, DateTime now) =>
      at != null && now.difference(at) <= const Duration(days: 7);

  /// The servers its open sessions run on, in first-seen order.
  List<String> get machines {
    final seen = <String>{};
    return [
      for (final s in sessions)
        if (!s.closed && s.server != null && seen.add(s.server!)) s.server!,
    ];
  }

  /// The sessions a pause is sent to: every one not closed.
  List<McSubjectSession> get liveSessions => [for (final s in sessions) if (!s.closed) s];
}

/// A server the subjects view asked, and whether it answered.
class McServerState {
  final String name;
  final bool ok;
  const McServerState(this.name, this.ok);

  static McServerState? fromJson(dynamic json) {
    final m = _map(json);
    final name = _str(m['name']);
    return name == null ? null : McServerState(name, _bool(m['ok']));
  }
}

/// `GET /api/mc/subjects?project=&area=`.
class McSubjects {
  final List<McSubject> subjects;
  final List<McRun> runs;
  final List<McServerState> servers;
  final DateTime? generatedAt;

  const McSubjects({
    this.subjects = const [],
    this.runs = const [],
    this.servers = const [],
    this.generatedAt,
  });

  static McSubjects fromJson(dynamic json) {
    final m = _map(json);
    return McSubjects(
      subjects: _firstOf(_list(m['subjects'], McSubject.fromJson), (s) => s.key),
      runs: _firstOf(_list(m['runs'], McRun.fromJson), (r) => r.id),
      servers: _list(m['servers'], McServerState.fromJson),
      generatedAt: _at(m['generatedAt']),
    );
  }
}

/// `GET /api/mc/subjects/:key`.
class McSubjectDetail {
  final McSubject? subject;
  final List<McRun> runs;
  final DateTime? generatedAt;
  const McSubjectDetail({this.subject, this.runs = const [], this.generatedAt});

  static McSubjectDetail fromJson(dynamic json) {
    final m = _map(json);
    return McSubjectDetail(
      subject: McSubject.fromJson(m['subject']),
      runs: _firstOf(_list(m['runs'], McRun.fromJson), (r) => r.id),
      generatedAt: _at(m['generatedAt']),
    );
  }
}

/// The answer of `POST /api/sessions/:id/prompt` (the gated prompt, `lib/safe-prompt.js`):
/// typed, or refused with the server's reason code. [error] is a failure that is not a
/// refusal (an unreachable server, a session gone).
class McPromptResult {
  final bool delivered;
  final String? refused;
  final String? error;
  const McPromptResult({this.delivered = false, this.refused, this.error});

  static McPromptResult fromJson(dynamic json) {
    final m = _map(json);
    final refused = m['refused'];
    return McPromptResult(
      delivered: _bool(m['delivered']),
      refused: refused is String ? _str(refused) : null,
      error: _str(m['error']),
    );
  }

  /// What the screen says.
  String get text {
    if (delivered) return 'told';
    final r = refused;
    if (r != null) return 'not told: ${mcRefusalText(r)}';
    return 'not told: ${error ?? 'no answer'}';
  }
}

/// A gated-prompt refusal code (`lib/safe-prompt.js` REASONS) in plain words; a code this
/// app does not know is shown as sent.
String mcRefusalText(String code) => switch (code) {
      'busy' => 'another prompt is being typed into it right now',
      'draft' => 'someone has unsent text in its prompt box',
      'typing' => 'someone typed into it moments ago',
      'not-idle' => 'it is in the middle of a turn',
      'waiting' => 'it is waiting on a question or a permission',
      'not-ready' => 'its agent is still starting',
      'no-agent' => 'it runs no agent',
      'agent-gone' => 'its agent has exited',
      'blocked-prompt' => 'a startup dialog is open in it',
      'menu' => 'a menu is open in it',
      'compacting' => 'it is compacting its context',
      'capped' => 'it is waiting out a usage limit',
      'api-error' => 'it is recovering from an API error',
      'check-in' => 'a check-in was just typed into it',
      'restart-hold' => 'a server restart is being agreed',
      'handoff' => 'it is handing off to a successor',
      'handed-off' => 'it handed off to a successor',
      'stale' => 'it reported again since',
      'worker-unavailable' => 'its server could not type into it',
      _ => code,
    };

// --- Start work (#512): `GET /api/mc/machines`, `POST /api/mc/start` -----------------

/// One machine a session can be started on, as the authority ranks it.
class McMachine {
  final String name;

  /// Null for the authority itself (its own sessions), else the server's url.
  final String? url;

  /// Reachable, signed in, and known not to be held for a restart.
  final bool ok;

  /// Why it cannot take a session (offline, a restart hold, ...), or null.
  final String? why;
  final int sessions;
  final int working;

  /// CPU percent, or null when unknown.
  final int? load;

  const McMachine({required this.name, this.url, this.ok = false, this.why, this.sessions = 0, this.working = 0, this.load});

  static McMachine? fromJson(dynamic json) {
    final m = _map(json);
    final name = _str(m['name']);
    if (name == null) return null;
    final load = m['load'];
    return McMachine(
      name: name,
      url: _str(m['url']),
      ok: _bool(m['ok']),
      why: _str(m['why']),
      sessions: _count(m['sessions']),
      working: _count(m['working']),
      load: load is num && load.isFinite ? load.round() : null,
    );
  }

  /// `3 sessions, 1 working, CPU 40%`, or why it cannot take one.
  String get line {
    final busy = '$sessions session${sessions == 1 ? '' : 's'}, $working working${load == null ? '' : ', CPU $load%'}';
    return ok ? busy : '${why ?? 'not available'} - $busy';
  }
}

/// `GET /api/mc/machines`.
class McMachines {
  final List<McMachine> machines;

  /// The name of the machine the server suggests (least loaded healthy one), or null.
  final String? suggested;
  const McMachines({this.machines = const [], this.suggested});

  static McMachines fromJson(dynamic json) {
    final m = _map(json);
    return McMachines(machines: _list(m['machines'], McMachine.fromJson), suggested: _str(m['suggested']));
  }
}

/// `POST /api/mc/start`'s answer: the session it started and where.
class McStartResult {
  final String sessionId;
  final String? name;
  final String? server;

  /// Null when the session runs on the authority itself.
  final String? serverUrl;
  const McStartResult({required this.sessionId, this.name, this.server, this.serverUrl});

  static McStartResult? fromJson(dynamic json) {
    final m = _map(json);
    final id = _str(m['sessionId']);
    if (id == null) return null;
    return McStartResult(sessionId: id, name: _str(m['name']), server: _str(m['server']), serverUrl: _str(m['serverUrl']));
  }
}
