// #569 - Mission Control shows an Azure DevOps item's STATION (its workflow state as ADO
// names it) where it shows a stage, and the server holds the stage to it (lib/mc-stage.js
// STATION_CAPS). The companion renders what the server sent and keeps no ADO state table:
//   * the wire carries `stage.station`, and its absence (a GitHub item, an older server) is null;
//   * a subject's row says "Parked", never the stage a session reported;
//   * the stage track's semantic label and the Subject screen's progress track say the station,
//     and an item with a station leaves out the reported / evidence halves.
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/screens/mission_control/subject_screen.dart';
import 'package:ai_terminal/screens/mission_control/subject_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _subject({Map<String, dynamic>? stage}) => {
      'key': 'ado:25678',
      'ref': 'ado:25678',
      'title': 'Parked item',
      'stage': stage ?? <String, dynamic>{},
      'meta': {'type': 'Bug', 'state': 'Parked'},
    };

/// What the server sends for a Parked item whose session reported merged: shown in-review
/// (the cap), the station beside it, the reported half still saying what the session said.
Map<String, dynamic> get _parked => {
      'current': 'in-review',
      'reported': 'merged',
      'evidence': 'merged',
      'station': 'Parked',
      'history': [
        {'stage': 'fixing', 'at': 1767222000000, 'source': 'report', 'detail': 'reported by a session'},
      ],
    };

Future<void> _pump(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(800, 1200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child))));
}

void main() {
  group('wire', () {
    test('the station is read; no station is null (a GitHub item, an older server)', () {
      expect(McSubject.fromJson(_subject(stage: _parked))!.stage.station, 'Parked');
      expect(McSubject.fromJson(_subject(stage: {'current': 'merged'}))!.stage.station, isNull);
      expect(McSubject.fromJson(_subject())!.stage.station, isNull);
      expect(McStage.fromJson({'station': ''}).station, isNull);
    });

    test('the label is the station, else the generic stage, else nothing', () {
      expect(McStage.fromJson(_parked).label, 'Parked');
      expect(McStage.fromJson({'current': 'pr-open'}).label, 'PR open');
      expect(const McStage().label, isNull);
      // A station with no stage under it (an item In Progress that nobody staged) still has its label.
      expect(McStage.fromJson({'station': 'In Progress'}).label, 'In Progress');
    });
  });

  group('a subject row', () {
    testWidgets('an ADO item says its station, never the stage a session reported', (tester) async {
      await _pump(tester, McSubjectRow(subject: McSubject.fromJson(_subject(stage: _parked))!, onTap: () {}));
      final step = tester.widget<Text>(find.byKey(const ValueKey('mc-subject-step')));
      expect(step.data, 'Parked');
      expect(find.textContaining('Merged'), findsNothing);
      expect(find.textContaining('merged'), findsNothing);
      expect(find.byKey(const ValueKey('mc-track-in-review-on')), findsOneWidget, reason: "the track follows the server's capped stage");
      expect(find.byKey(const ValueKey('mc-track-merged-off')), findsOneWidget);
    });

    testWidgets('a GitHub item keeps the generic stage label', (tester) async {
      final s = McSubject.fromJson(_subject(stage: {'current': 'merged', 'station': null}))!;
      await _pump(tester, McSubjectRow(subject: s, onTap: () {}));
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-subject-step'))).data, 'Merged');
    });

    testWidgets('no stage and no station still says so', (tester) async {
      await _pump(tester, McSubjectRow(subject: McSubject.fromJson(_subject())!, onTap: () {}));
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-subject-step'))).data, 'no stage yet');
    });

    testWidgets("the track's semantic label names the station", (tester) async {
      final handle = tester.ensureSemantics();
      await _pump(tester, McStageTrack(stage: McStage.fromJson(_parked)));
      expect(find.bySemanticsLabel('stage Parked'), findsOneWidget);
      handle.dispose();
    });
  });

  group('the progress track', () {
    testWidgets('an ADO item shows its station and not the reported / evidence halves', (tester) async {
      await _pump(tester, McProgressTrack(stage: McStage.fromJson(_parked)));
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-stage-station'))).data, 'Station: Parked');
      expect(find.byKey(const ValueKey('mc-stage-halves')), findsNothing);
      expect(find.text('reported Merged · evidence Merged'), findsNothing);
      expect(find.text('No stage reported or seen yet.'), findsNothing);
      // The server's capped stage is the current step; merged is not reached.
      expect(find.descendant(of: find.byKey(const ValueKey('mc-step-in-review')), matching: find.byIcon(Icons.radio_button_checked)), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('mc-step-merged')), matching: find.byIcon(Icons.radio_button_unchecked)), findsOneWidget);
    });

    testWidgets('a GitHub item keeps the halves and has no station line', (tester) async {
      await _pump(tester, McProgressTrack(stage: McStage.fromJson({'current': 'merged', 'reported': 'fixing', 'evidence': 'merged'})));
      expect(find.byKey(const ValueKey('mc-stage-station')), findsNothing);
      expect(tester.widget<Text>(find.byKey(const ValueKey('mc-stage-halves'))).data, 'reported Fixing · evidence Merged');
    });
  });
}
