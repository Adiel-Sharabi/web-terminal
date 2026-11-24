// #511 - Mission Control Ask: the wire shapes of `POST /api/mc/ask`
// (`docs/mission-control.md`, "Questions context and Ask"). The server builds the answer and
// names its sources; the app renders them and decides nothing.

/// What a question is about. [kind] is `all`, `project`, `subject` or `session`.
class McAskScope {
  final String kind;
  final String? id;

  const McAskScope._(this.kind, this.id);

  /// Every session in the cluster.
  static const McAskScope all = McAskScope._('all', null);

  /// One project's sessions (`Project.id`).
  const McAskScope.project(String this.id) : kind = 'project';

  /// One work item and the sessions on it (its key: `owner/repo#N`, `ado:N`).
  const McAskScope.subject(String this.id) : kind = 'subject';

  /// One session.
  const McAskScope.session(String this.id) : kind = 'session';

  Map<String, Object?> toJson() => {'kind': kind, if (id != null) 'id': id};

  @override
  bool operator ==(Object other) => other is McAskScope && other.kind == kind && other.id == id;

  @override
  int get hashCode => Object.hash(kind, id);
}

/// One source an answer relies on: a session, its report or recap, a work item, a PR.
class McSource {
  /// The id the answer cites inline (`[S3]`).
  final String id;

  /// `session`, `report`, `recap`, `workitem` or `pr`.
  final String kind;
  final String label;
  final String? server;
  final String? sessionId;

  /// When the data this source holds was written or read; null when unknown.
  final DateTime? at;
  final String? url;

  const McSource({required this.id, required this.kind, required this.label, this.server, this.sessionId, this.at, this.url});

  /// Opens a session (session, report, recap) or a link (work item, PR).
  bool get opensSession => sessionId != null && sessionId!.isNotEmpty;

  static McSource? fromJson(dynamic json) {
    if (json is! Map) return null;
    final kind = json['kind'];
    if (kind is! String) return null;
    return McSource(
      id: json['id'] is String ? json['id'] as String : '',
      kind: kind,
      label: json['label'] is String ? json['label'] as String : kind,
      server: json['server'] is String ? json['server'] as String : null,
      sessionId: json['sessionId'] is String ? json['sessionId'] as String : null,
      at: _ms(json['at']),
      url: json['url'] is String ? json['url'] as String : null,
    );
  }
}

/// What did not fit in the Analyst's context: the answer may miss these.
class McAskCut {
  final int omitted;
  final int total;
  final int itemsOmitted;
  final int itemsTotal;
  const McAskCut({this.omitted = 0, this.total = 0, this.itemsOmitted = 0, this.itemsTotal = 0});

  String get text {
    final parts = [
      if (omitted > 0) '$omitted of $total sessions',
      if (itemsOmitted > 0) '$itemsOmitted of $itemsTotal work items',
    ];
    return 'Too much to read at once: ${parts.join(' and ')} were left out, so the answer may miss them.';
  }
}

/// The Analyst's answer.
class McAnswer {
  /// Plain text: shown as text, never parsed as markdown or HTML.
  final String answer;
  final List<McSource> sources;

  /// The oldest and newest time of the data the answer was given.
  final DateTime? oldestAt;
  final DateTime? newestAt;
  final McAskCut? cut;

  /// The model that answered; null when the server answered itself (an empty scope).
  final String? model;
  final DateTime? generatedAt;

  const McAnswer({required this.answer, this.sources = const [], this.oldestAt, this.newestAt, this.cut, this.model, this.generatedAt});

  factory McAnswer.fromJson(Map<String, dynamic> m) {
    final age = m['dataAge'] is Map ? m['dataAge'] as Map : const {};
    final cut = m['cut'] is Map ? m['cut'] as Map : null;
    return McAnswer(
      answer: m['answer'] is String ? m['answer'] as String : '',
      sources: [
        for (final s in (m['sources'] is List ? m['sources'] as List : const [])) ?McSource.fromJson(s),
      ],
      oldestAt: _ms(age['oldestAt']),
      newestAt: _ms(age['newestAt']),
      cut: cut == null
          ? null
          : McAskCut(
              omitted: _int(cut['omitted']),
              total: _int(cut['total']),
              itemsOmitted: _int(cut['itemsOmitted']),
              itemsTotal: _int(cut['itemsTotal'])),
      model: m['model'] is String ? m['model'] as String : null,
      generatedAt: _ms(m['generatedAt']),
    );
  }

  /// The words for a `502`/`503` `{status, reason}` answer.
  static String failureText(Object? reason) => switch (reason) {
        'busy' => 'The Analyst is busy with other questions: try again in a moment',
        'disabled' => 'Ask is turned off on the Mission Control server',
        'no-cli' => 'The Mission Control server has no Claude CLI to answer with',
        'timeout' => 'The Analyst took too long: try a narrower scope or question',
        _ => 'The Analyst could not answer: try again',
      };
}

DateTime? _ms(Object? v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
int _int(Object? v) => v is num ? v.toInt() : 0;
