// #166 — the phone can attach ANY file, not just a camera-roll image.
//
// The document picker itself cannot be exercised here: it is an OS Activity
// whose result never traverses a synthetic event — the same reason #90's drop
// gesture is untestable, and #55's Enter needed a real-input rig. What IS
// testable is everything that decides the behaviour around it: which sources the
// sheet offers on which platform, what a tapped row pops, and the mapping that
// makes a picked file take the *dropped* file's staging path rather than growing
// a third one.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/attach_source_sheet.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';
import 'package:file_selector/file_selector.dart' show XFile;

/// Smallest valid PNG, so the thumbnail path decodes for real.
Uint8List _png1x1() => Uint8List.fromList(const [
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

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

  group('attachBatchMessage', () {
    test('says nothing when the whole batch landed', () {
      expect(
        attachBatchMessage(total: 3, failures: const [], tooLarge: const []),
        isNull,
      );
    });

    test('a failure keeps the wording the drop path already had', () {
      expect(
        attachBatchMessage(total: 1, failures: const ['a.pdf'], tooLarge: const []),
        'Could not attach a.pdf',
      );
      expect(
        attachBatchMessage(
            total: 3, failures: const ['a.pdf', 'b.zip'], tooLarge: const []),
        'Could not attach 2 of 3 files',
      );
    });

    test('a size is named as a size, never as a failure', () {
      // "Could not attach holiday.mp4" sends someone hunting for a fault that
      // is really a limit — the distinction is the point of the separate list.
      final msg = attachBatchMessage(
          total: 1, failures: const [], tooLarge: const ['holiday.mp4']);
      expect(msg, contains('holiday.mp4'));
      expect(msg, contains('50 MB'));
      expect(msg, isNot(contains('Could not attach')));
    });

    test('a batch that failed BOTH ways reports both, in one line', () {
      final msg = attachBatchMessage(
        total: 4,
        failures: const ['a.pdf', 'b.zip'],
        tooLarge: const ['c.mp4', 'd.mov'],
      );
      expect(msg, contains('Could not attach 2 of 4 files'));
      expect(msg, contains('2 files are larger than the 50 MB limit'));
      expect('\n'.allMatches(msg!), isEmpty); // one snackbar, one line
    });

    test('the limit tracks the SERVER, which owns it', () {
      // The client copy exists only to refuse a file before spending a phone's
      // data on a 413. If server.js's own limit moves, this goes red rather
      // than the app quietly refusing files the server would have taken.
      final serverJs = File('../server.js').readAsStringSync();
      final declared = RegExp(
              r"upload-file[\s\S]{0,200}?limit:\s*'(\d+)mb'")
          .firstMatch(serverJs);
      expect(declared, isNotNull,
          reason: "could not find /api/upload-file's raw-body limit in server.js");
      expect(
        ApiClient.uploadLimitBytes,
        int.parse(declared!.group(1)!) * 1024 * 1024,
      );
    });
  });

  group('attachment thumbnails', () {
    testWidgets('a chip decodes at chip size, not at photo size', (tester) async {
      // A Files-picked image is NOT re-encoded the way the camera-roll route's
      // `imageQuality: 90` re-encodes one, so its full-resolution bytes reach
      // the chip. Decoding a 12 MP photo for a 52px square is tens of MB of
      // ARGB on a phone — cacheWidth is what stops it.
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: ComposeBar(
            controller: TextEditingController(),
            focusNode: FocusNode(),
            onSend: () {},
            isLive: false,
            attachments: [ComposeAttachment(name: 'shot.png', bytes: _png1x1())],
          ),
        ),
      ));
      await tester.pump();
      final provider = tester.widget<Image>(find.byType(Image)).image;
      // cacheWidth is what wraps the provider; a bare MemoryImage here means
      // the chip is decoding the whole photo.
      expect(provider, isA<ResizeImage>());
      expect((provider as ResizeImage).width, 104);
      expect(provider.height, isNull, reason: 'pinning both squashes the aspect');
    });
  });
}
