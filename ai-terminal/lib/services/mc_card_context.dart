// #571 - what a Mission Control card's full-context sheet reads: the session's OWN last reply in
// full (not the TL;DR the card shows, and not a model's account of it - that is "More context"),
// and every work item the session names with where it stands.
//
// Nothing here decides anything: the reply is the transcript's text as the server's recap hands
// it over (`GET /api/sessions/:id/recap?full=1`, `lib/recap.js`), the station and stage are the
// server's (`McStage.label`: an ADO item's station, else its stage) and the items are the ones the
// session reported on its brief. The card's session is found the way every answer to it is found
// ([mcSessionOfCard]), and a peer's session is read through the server that lists it - the same
// path as the question on its screen. Every read DEGRADES: a failure is a line the sheet shows,
// never an error and never a missing section.

import '../api/api_client.dart' show ApiClient, ApiException;
import '../api/mc_models.dart';
import '../api/models.dart';
import 'mc_pick_sender.dart' show mcSessionOfCard;

/// The session's last reply, as the sheet shows it.
class McContextReply {
  const McContextReply({this.text, this.at, this.whole = false, this.problem});

  /// The reply, markdown as the agent wrote it; null when there is none to show.
  final String? text;

  /// When the agent wrote it.
  final DateTime? at;

  /// True when [text] is the whole reply; false when it is only the server's short reminder of it
  /// (a server that cannot give the whole text yet), which the sheet says.
  final bool whole;

  /// Why there is no [text] when the reason is a failure (the session is not in this app's list,
  /// the read failed); null when the session simply has not written a reply.
  final String? problem;
}

/// One work item the session names, with where it stands.
class McContextItem {
  const McContextItem({required this.key, required this.ref, this.title, this.state, this.stage, this.station, this.note, this.url});

  /// What opens the item's page: the subject's own key when the server knew it, else the
  /// session's key for it.
  final String key;
  final String ref;
  final String? title;

  /// The state the SESSION reported (`in-progress`, `committed`, ...); null when it said none.
  final String? state;

  /// The server's stage for the item (`pr-open`, ...), shown when the item has no [station]; null
  /// when the server has none or could not be asked.
  final String? stage;

  /// An Azure DevOps item's station: its work item state as ADO names it (#569), the authority on
  /// how far its code got. Null for a GitHub item and when the tracker was never read.
  final String? station;
  final String? note;
  final String? url;

  /// The words the item's place is shown in: the station when it has one (the authority, #569),
  /// else the stage's label; null when neither is known.
  String? get where => station != null ? 'Station: $station' : (stage == null ? null : 'Stage: ${mcStageLabel(stage!)}');
}

/// How long one item's page is waited for: a slow tracker leaves the item without its station,
/// never the sheet without its items.
const Duration kMcContextSubjectWait = Duration(seconds: 4);

class McCardContextReader {
  McCardContextReader({required this.sessions, required this.client, required this.subject});

  /// The sessions the app knows now (the repository's current list).
  final List<Session> Function() sessions;

  /// The client of one of the app's servers.
  final ApiClient Function(ServerConfig server) client;

  /// The item's page from the server that answers Mission Control ([McFeed.subject]).
  final Future<McSubjectDetail> Function(String key) subject;

  /// The card's session reply, in full when the server can give it.
  Future<McContextReply> reply(McCard card) async {
    final s = mcSessionOfCard(sessions(), card);
    if (s == null) {
      return const McContextReply(problem: "That session is not in this app's list, so its reply cannot be read here. Open the session to see it.");
    }
    try {
      final entry = (await client(s.server).recap(s.id, full: true)).reply;
      if (entry == null) return const McContextReply();
      return McContextReply(text: entry.full ?? entry.text, at: DateTime.tryParse(entry.at ?? ''), whole: entry.full != null);
    } on ApiException catch (e) {
      return McContextReply(problem: 'Its reply could not be read: ${e.message}');
    } catch (e) {
      return McContextReply(problem: 'Its reply could not be read ($e)');
    }
  }

  /// Every item the card's session names (its brief), the card's own item first when the session
  /// does not list it, each with its station or stage. Empty when there are none.
  Future<List<McContextItem>> items(McCard card) async {
    final s = mcSessionOfCard(sessions(), card);
    final named = <BriefItem>[
      for (final i in s?.brief?.items ?? const <BriefItem>[]) i,
    ];
    final ownKey = card.subjectKey ?? card.ref;
    if (ownKey != null && !named.any((i) => i.key == ownKey || i.ref == ownKey || i.ref == card.ref)) {
      named.insert(0, BriefItem(ref: card.ref ?? ownKey, key: ownKey, title: card.title ?? ''));
    }
    return Future.wait(named.map(_item));
  }

  Future<McContextItem> _item(BriefItem i) async {
    McSubject? sub;
    try {
      sub = (await subject(i.key).timeout(kMcContextSubjectWait)).subject;
    } catch (_) {
      sub = null; // the item still shows, without where it stands
    }
    final title = i.title.isNotEmpty ? i.title : sub?.titleLabel;
    return McContextItem(
      key: sub?.key ?? i.key,
      ref: i.ref,
      title: title == null || title.isEmpty ? null : title,
      state: i.state,
      stage: sub?.stage.current,
      station: sub?.stage.station,
      note: i.note.isEmpty ? null : i.note,
      url: i.url,
    );
  }
}
