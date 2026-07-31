// #90 — dropping files onto the session stages them as compose attachments.
//
// The drop gesture itself cannot be exercised here (it originates in the OS, and
// a synthetic event never traverses that path — the same reason #55's Enter
// contract and #83's selection needed real-input rigs). What IS testable, and
// what actually decides the behaviour, is the rendering rule and the pure
// predicate behind it.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

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
  group('droppedFileIsImage', () {
    test('recognises the common image extensions, case-insensitively', () {
      for (final n in ['a.png', 'B.JPG', 'c.jpeg', 'd.GIF', 'e.webp', 'f.bmp',
          'g.heic', 'h.HEIF']) {
        expect(droppedFileIsImage(n), isTrue, reason: n);
      }
    });

    test('anything else is a plain file', () {
      for (final n in ['notes.txt', 'archive.zip', 'report.pdf', 'main.dart',
          'no-extension', '']) {
        expect(droppedFileIsImage(n), isFalse, reason: n);
      }
    });

    test('a name merely CONTAINING an image extension is not an image', () {
      // Matching anywhere would treat a decoy like this as an image and try to
      // render arbitrary bytes as a thumbnail.
      expect(droppedFileIsImage('png.txt'), isFalse);
      expect(droppedFileIsImage('report.pdf.zip'), isFalse);
      expect(droppedFileIsImage('my.jpeg.exe'), isFalse);
    });
  });

  group('compose bar attachment chips', () {
    Widget host(List<ComposeAttachment> a, {void Function(int)? onRemove}) =>
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: ComposeBar(
              controller: TextEditingController(),
              focusNode: FocusNode(),
              onSend: () {},
              isLive: false,
              attachments: a,
              onRemoveAttachment: onRemove,
            ),
          ),
        );

    testWidgets('a non-image attachment shows its NAME, not a blank thumbnail',
        (tester) async {
      await tester.pumpWidget(host([
        const ComposeAttachment(name: 'quarterly-report.pdf'),
      ]));
      await tester.pump();
      // The name is the only thing distinguishing two dropped files.
      expect(find.text('quarterly-report.pdf'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('an image attachment still renders a thumbnail', (tester) async {
      await tester.pumpWidget(host([
        ComposeAttachment(name: 'shot.png', bytes: _png1x1()),
      ]));
      await tester.pump();
      expect(find.byType(Image), findsOneWidget);
      // The thumbnail IS the chip — no filename caption competing with it.
      expect(find.text('shot.png'), findsNothing);
    });

    testWidgets('mixed images and files coexist, each removable', (tester) async {
      int? removed;
      await tester.pumpWidget(host(
        [
          ComposeAttachment(name: 'a.png', bytes: _png1x1()),
          const ComposeAttachment(name: 'b.zip'),
        ],
        onRemove: (i) => removed = i,
      ));
      await tester.pump();
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('b.zip'), findsOneWidget);

      // Each chip carries its own ✕.
      expect(find.byIcon(Icons.close), findsNWidgets(2));
      await tester.tap(find.byIcon(Icons.close).last);
      await tester.pump();
      expect(removed, 1);
    });
  });
}
