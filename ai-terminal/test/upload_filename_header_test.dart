// #166 — a picked file's NAME must not be able to fail the whole attach.
//
// These tests drive a REAL `dart:io` HttpServer through the client's OWN default
// http.Client, and that is the entire point: the defect lives in `dart:io`'s
// header-value validation, which a `MockClient` never traverses. Mocked, this
// upload passes while the shipped app throws a FormatException on every Hebrew,
// accented or emoji file name — a whole class of name that is routine in a
// phone's Downloads folder and rare in a desktop drop, which is why #90 never
// hit it and #166 aims straight at it.
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late HttpServer server;
  late List<String?> seenFilenames;
  late List<String?> seenEncodedFlags;

  setUp(() async {
    seenFilenames = <String?>[];
    seenEncodedFlags = <String?>[];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      seenFilenames.add(req.headers.value('x-filename'));
      seenEncodedFlags.add(req.headers.value(encodedFilenameHeader));
      await req.drain<void>();
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'ok': true, 'path': r'C:\srv\dropped\1-x.pdf'}));
      await req.response.close();
    });
  });

  tearDown(() async => server.close(force: true));

  ApiClient clientForServer() => ApiClient(ServerConfig(
        name: 'local',
        baseUrl: 'http://127.0.0.1:${server.port}',
        bearerToken: 'tok',
      ));

  test('the upload allowance scales with the body', () async {
    // A flat 30s cannot deliver the 50 MB this route advertises: a 25 MB PDF on
    // cellular would need a sustained ~7 Mbps just to beat the timer, and
    // losing that race reports a failure for a file the server may have
    // written.
    expect(ApiClient.uploadTimeoutFor(0), const Duration(seconds: 30));
    expect(
      ApiClient.uploadTimeoutFor(ApiClient.uploadLimitBytes),
      greaterThan(const Duration(minutes: 5)),
    );
    // Monotonic, so a bigger body never gets a shorter allowance.
    expect(ApiClient.uploadTimeoutFor(20 * 1024 * 1024),
        greaterThan(ApiClient.uploadTimeoutFor(5 * 1024 * 1024)));
  });

  test('a Hebrew file name uploads instead of failing the attach', () async {
    // Raw, this header value throws FormatException inside dart:io before a
    // byte reaches the wire, and `uploadDroppedFile`'s catch turns that into
    // "Could not attach <name>" with no hint of the real cause.
    const name = '\u05D3\u05D5\u05D7.pdf'; // דוח.pdf
    final path = await clientForServer().uploadDroppedFile(
      <int>[1, 2, 3],
      filename: name,
    );
    expect(path, r'C:\srv\dropped\1-x.pdf');
    expect(seenFilenames.single, isNotNull);
    // Whatever encoding is chosen, the original name must be recoverable —
    // otherwise the server could never restore it even once it wants to.
    expect(Uri.decodeComponent(seenFilenames.single!), name);
  });

  test('an emoji name uploads too', () async {
    const name = '\u{1F4C4}-report.pdf';
    await clientForServer().uploadDroppedFile(<int>[1], filename: name);
    expect(Uri.decodeComponent(seenFilenames.single!), name);
  });

  test('a plain ASCII name is sent verbatim, exactly as before', () async {
    // The server slices this name with `safeDropName`, which maps anything
    // outside [A-Za-z0-9._-] to '_'. Encoding unconditionally would turn a
    // space into `%20` and land `my_20file.pdf` on disk — worse than today's
    // `my_file.pdf` — so only a name that cannot ride the header is encoded.
    for (final name in ['report.pdf', 'my file.pdf', 'a-b_c.1.log']) {
      seenFilenames.clear();
      await clientForServer().uploadDroppedFile(<int>[1], filename: name);
      expect(seenFilenames.single, name, reason: name);
    }
  });

  test('an encoded name is ANNOUNCED, so the receiver need not guess', () async {
    // The value alone is ambiguous: `100%-done.pdf` rides verbatim and would
    // throw in a receiver that decoded everything. The marker is what lets a
    // future server-side decode run on exactly the right values.
    await clientForServer()
        .uploadDroppedFile(<int>[1], filename: '\u05D3.pdf');
    expect(seenEncodedFlags.single, '1');
  });

  test('a literal name carries no marker', () async {
    for (final name in ['report.pdf', '100%-done.pdf', 'a b.txt']) {
      seenFilenames.clear();
      seenEncodedFlags.clear();
      await clientForServer().uploadDroppedFile(<int>[1], filename: name);
      expect(seenFilenames.single, name, reason: name);
      expect(seenEncodedFlags.single, isNull, reason: name);
    }
  });

  group('headerSafeFilename', () {
    test('a long non-ASCII name keeps its extension', () {
      // Each Hebrew letter costs six characters encoded, so a 14-letter name
      // overruns the server's 80-character slice — and what the slice cuts off
      // is the END, i.e. the `.pdf`. An extension-less file is one the agent
      // can no longer tell the type of.
      final long = '${'\u05D3' * 20}.pdf';
      final out = headerSafeFilename(long);
      expect(out.length, lessThanOrEqualTo(serverFilenameBudget));
      expect(out, endsWith('.pdf'));
    });

    test('a truncated name is still decodable — never a half escape', () {
      // Cutting the ENCODED string could end on `%D7`, which decodes to
      // nothing at all; the truncation walks whole characters instead.
      final out = headerSafeFilename('${'\u05D3' * 40}.pdf');
      expect(() => Uri.decodeComponent(out), returnsNormally);
      expect(Uri.decodeComponent(out), endsWith('.pdf'));
    });

    test('an extension-less long name is still capped', () {
      final out = headerSafeFilename('\u05D3' * 40);
      expect(out.length, lessThanOrEqualTo(serverFilenameBudget));
      expect(() => Uri.decodeComponent(out), returnsNormally);
    });

    test('a long ASCII name keeps its extension too', () {
      // The common case, not the exotic one: the server's slice takes the same
      // bite out of a 100-character English name, and what it cuts is the
      // `.pdf`. Nothing about it needs ENCODING — but it does need the budget.
      final long = '${'quarterly-report-' * 8}.pdf';
      expect(long.length, greaterThan(serverFilenameBudget));
      final out = headerSafeFilename(long);
      expect(out.length, lessThanOrEqualTo(serverFilenameBudget));
      expect(out, endsWith('.pdf'));
      // Still literal: a name that never needed encoding must not acquire it.
      expect(out, isNot(contains('%')));
    });

    test('a short ASCII name is untouched by the budget', () {
      expect(headerSafeFilename('my file.pdf'), 'my file.pdf');
    });

    test('a name whose EXTENSION alone busts the budget still fits', () {
      // `backup.<a Hebrew sentence>` has no real extension: the text after the
      // last dot encodes past 80 on its own. Keeping it would return a value
      // over budget for the server to slice mid-escape — the exact undecodable
      // half-`%D7` the rune-walk exists to avoid.
      final out = headerSafeFilename('backup.${'\u05D3' * 20}');
      expect(out.length, lessThanOrEqualTo(serverFilenameBudget));
      expect(() => Uri.decodeComponent(out), returnsNormally);
      expect(Uri.decodeComponent(out), startsWith('backup.'));
    });

    test('the budget tracks the SERVER, which owns the slice', () {
      // Relative to the package root, which is where `flutter test` runs (CI
      // sets working-directory: ai-terminal). Said out loud, because a bare
      // FileSystemException here reads as a broken test rather than as "this
      // guard could not find the server it mirrors".
      final serverFile = File('../server.js');
      expect(serverFile.existsSync(), isTrue,
          reason: 'run flutter test from ai-terminal/ — this guard reads server.js');
      final serverJs = serverFile.readAsStringSync();
      final declared = RegExp(r'function safeDropName[\s\S]{0,400}?\.slice\(0,\s*(\d+)\)')
          .firstMatch(serverJs);
      expect(declared, isNotNull,
          reason: "could not find safeDropName's slice in server.js");
      expect(serverFilenameBudget, int.parse(declared!.group(1)!));
    });

    test('leaves every printable ASCII name untouched', () {
      for (final n in ['a.txt', 'my file.pdf', "quote'.txt", 'a%b.txt']) {
        expect(headerSafeFilename(n), n, reason: n);
      }
    });

    test('encodes anything a header cannot carry', () {
      // dart:io accepts a value byte only when it is > 31 and < 128.
      expect(headerSafeFilename('\u05D3.pdf'), '%D7%93.pdf');
      expect(headerSafeFilename('a\nb.txt'), isNot(contains('\n')));
      for (final unit in headerSafeFilename('\u{1F4C4}\u00E9\t.pdf').codeUnits) {
        expect(unit, greaterThan(31));
        expect(unit, lessThan(128));
      }
    });
  });
}
