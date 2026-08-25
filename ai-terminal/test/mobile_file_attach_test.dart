// #166 — the phone can attach ANY file, not just a camera-roll image.
//
// The document picker itself cannot be exercised here: it is an OS Activity
// whose result never traverses a synthetic event — the same reason #90's drop
// gesture is untestable, and #55's Enter needed a real-input rig. What IS
// testable is everything that decides the behaviour around it: which sources the
// sheet offers on which platform, what a tapped row pops, and the mapping that
// makes a picked file take the *dropped* file's staging path rather than growing
// a third one.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/attach_source_sheet.dart';
import 'package:file_selector/file_selector.dart' show XFile;

void main() {
  group('attachSourcesFor', () {
    test('mobile offers Files — the whole point of #166', () {
      expect(attachSourcesFor(desktop: false), contains(AttachSource.files));
    });

    test('desktop does NOT: it already has the drop (#90)', () {
      // Two doors to one capability is the thing the issue explicitly rules
      // out, and a desktop `openFiles()` has no endorsed implementation here.
      expect(
        attachSourcesFor(desktop: true),
        isNot(contains(AttachSource.files)),
      );
    });

    test('the existing two sources keep their identity and order', () {
      // Camera and Gallery are muscle memory; the new row lands last.
      expect(attachSourcesFor(desktop: true),
          const [AttachSource.camera, AttachSource.gallery]);
      expect(attachSourcesFor(desktop: false),
          const [AttachSource.camera, AttachSource.gallery, AttachSource.files]);
    });
  });

  group('AttachSourceSheet', () {
    /// Pumps the sheet the way the attach button does — inside a route, so a
    /// tapped row's `Navigator.pop` is what the test reads.
    Future<AttachSource?> tapRow(WidgetTester tester, List<AttachSource> sources,
        String label) async {
      AttachSource? popped;
      var opened = false;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                opened = true;
                popped = await showModalBottomSheet<AttachSource>(
                  context: context,
                  builder: (_) => AttachSourceSheet(sources: sources),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(opened, isTrue);
      if (find.text(label).evaluate().isEmpty) return null;
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
      return popped;
    }

    testWidgets('tapping Files pops AttachSource.files', (tester) async {
      expect(
        await tapRow(tester, attachSourcesFor(desktop: false), 'Files'),
        AttachSource.files,
      );
    });

    testWidgets('the image sources still pop what they always did',
        (tester) async {
      expect(
        await tapRow(tester, attachSourcesFor(desktop: false), 'Camera'),
        AttachSource.camera,
      );
      expect(
        await tapRow(tester, attachSourcesFor(desktop: false), 'Gallery'),
        AttachSource.gallery,
      );
    });

    testWidgets('a desktop sheet renders no Files row at all', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: AttachSourceSheet(sources: attachSourcesFor(desktop: true)),
        ),
      ));
      await tester.pump();
      expect(find.text('Camera'), findsOneWidget);
      expect(find.text('Gallery'), findsOneWidget);
      expect(find.text('Files'), findsNothing);
    });

    testWidgets('every offered source gets exactly one row', (tester) async {
      final sources = attachSourcesFor(desktop: false);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: AttachSourceSheet(sources: sources)),
      ));
      await tester.pump();
      expect(find.byType(ListTile), findsNWidgets(sources.length));
    });
  });

  group('AttachCandidate', () {
    /// An XFile carrying in-memory bytes under a name that exists NOWHERE on
    /// disk — which is the point: anything reading `path` instead of the bytes
    /// fails against it. (`XFile.fromData`'s own `name:` argument is web-only;
    /// on io the name is the path's basename, so the name has to ride there.)
    XFile picked(String name, List<int> bytes) =>
        XFile.fromData(Uint8List.fromList(bytes), path: name);

    test('an XFile keeps its name and yields its bytes', () async {
      final c = AttachCandidate.fromXFile(picked('notes.txt', [1, 2, 3]));
      expect(c.name, 'notes.txt');
      expect(await c.read(), [1, 2, 3]);
    });

    test('reads the BYTES, never the path — the SAF trap', () async {
      // Android hands back a content:// URI rather than a file, and the agent
      // runs on the SERVER anyway: a path from the picking device names a file
      // it cannot open. So the upload must come from readAsBytes; a candidate
      // whose path names nothing must still deliver its contents.
      final c = AttachCandidate.fromXFile(picked('report.pdf', [9]));
      expect(await c.read(), [9]);
    });

    test('a picked name is classified for the chip exactly like a dropped one',
        () {
      // Same predicate, so a picked screenshot gets a thumbnail and a picked
      // archive gets a named chip — indistinguishable from the drop path (#90).
      expect(
        droppedFileIsImage(AttachCandidate.fromXFile(picked('shot.PNG', [])).name),
        isTrue,
      );
      expect(
        droppedFileIsImage(AttachCandidate.fromXFile(picked('build.log', [])).name),
        isFalse,
      );
    });
  });
}
