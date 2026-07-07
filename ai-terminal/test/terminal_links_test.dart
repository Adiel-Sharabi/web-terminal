import 'package:ai_terminal/util/terminal_links.dart';
import 'package:flutter_test/flutter_test.dart';

// #26: tapping a printed http/https URL opens the browser. urlAtColumn is the
// pure core — given a column-aligned terminal line and the tapped column, it
// returns the URL under that cell or null. These lock the token boundaries,
// punctuation trimming, and the http/https-only safety gate.
void main() {
  // Returns the column of the first char of [needle] in [line].
  int colOf(String line, String needle) => line.indexOf(needle);

  test('returns the URL when any of its columns is tapped', () {
    const line = 'visit https://example.com/path now';
    final start = colOf(line, 'https');
    for (final c in [start, start + 4, line.indexOf('/path') + 2]) {
      expect(urlAtColumn(line, c), 'https://example.com/path',
          reason: 'column $c is inside the URL');
    }
  });

  test('returns null off the URL (surrounding words and spaces)', () {
    const line = 'visit https://example.com now';
    expect(urlAtColumn(line, colOf(line, 'visit')), isNull);
    expect(urlAtColumn(line, colOf(line, 'now')), isNull);
    expect(urlAtColumn(line, colOf(line, 'https') - 1), isNull); // the space
  });

  test('trims trailing sentence punctuation', () {
    const line = 'see https://example.com/docs.';
    expect(urlAtColumn(line, colOf(line, 'https') + 2),
        'https://example.com/docs');
  });

  test('trims wrapping parens/quotes but keeps balanced parens in the path', () {
    const wrapped = '(https://example.com)';
    expect(urlAtColumn(wrapped, 3), 'https://example.com');

    const quoted = '"https://example.com",';
    expect(urlAtColumn(quoted, 3), 'https://example.com');

    const balanced = 'https://en.wikipedia.org/wiki/Dart_(language)';
    expect(urlAtColumn(balanced, 5), balanced,
        reason: 'a closing paren whose opener is in the token stays');
  });

  test('http is accepted; other schemes and bare hosts are rejected', () {
    expect(urlAtColumn('http://x.test/a', 2), 'http://x.test/a');
    for (final bad in [
      'ftp://example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'example.com',
      'https://', // no host
    ]) {
      expect(urlAtColumn(bad, bad.length ~/ 2), isNull, reason: bad);
    }
  });

  test('out-of-range columns are null-safe', () {
    const line = 'https://example.com';
    expect(urlAtColumn(line, -1), isNull);
    expect(urlAtColumn(line, line.length), isNull);
    expect(urlAtColumn(line, 999), isNull);
  });

  test('a URL flush against the left edge (column 0) is detected', () {
    const line = 'https://example.com/x';
    expect(urlAtColumn(line, 0), 'https://example.com/x');
  });

  group('isLaunchableHttpUrl (chat link safety gate)', () {
    test('accepts http/https with a host', () {
      expect(isLaunchableHttpUrl('http://example.com'), isTrue);
      expect(isLaunchableHttpUrl('https://example.com/a?b=c#d'), isTrue);
    });

    test('rejects non-web schemes, hostless, and empty', () {
      for (final bad in [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>',
        'mailto:x@y.com',
        'ftp://example.com',
        'https://', // no host
        'example.com', // no scheme
        '',
      ]) {
        expect(isLaunchableHttpUrl(bad), isFalse, reason: bad);
      }
      expect(isLaunchableHttpUrl(null), isFalse);
    });
  });
}
