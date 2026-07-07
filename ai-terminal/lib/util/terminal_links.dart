/// Plain-text URL detection for the Terminal lens (#26).
///
/// Mirrors the web client's xterm `WebLinksAddon` (app.html): a whitespace-
/// delimited `http`/`https` token under the tapped cell becomes a link that
/// opens in the system browser. Kept pure (no Flutter/xterm types) so the token
/// extraction + validation is unit-testable; the caller turns a terminal buffer
/// line into a column-aligned string and hands it here.
///
/// Deliberately out of scope, matching the web addon's limits:
/// - OSC 8 hyperlinks — xterm.dart 4.0.0 has no per-cell hyperlink store, so an
///   `ESC]8` URI cannot be mapped back to the cell that was tapped without
///   forking the package.
/// - Persistent underline styling of every URL — xterm.dart 4.0.0 exposes no
///   per-cell decoration hook. The web `WebLinksAddon` is likewise regex-only
///   and styles on hover, which has no touch analogue.
///
/// Only `http`/`https` is ever returned, so `javascript:`, `file:`, `data:`
/// and similar schemes can never be launched.
library;

/// Whether [href] is a launchable http/https URL — the safety gate before
/// handing a chat markdown link (or autolinked bare URL) to `url_launcher`.
/// Rejects `javascript:` / `file:` / `data:` / `mailto:` and anything without a
/// host, so only real web links ever open. Pure, so it's unit-testable.
bool isLaunchableHttpUrl(String? href) {
  if (href == null || href.isEmpty) return false;
  final uri = Uri.tryParse(href);
  return uri != null &&
      (uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isNotEmpty;
}

/// Whitespace test on a single UTF-16 code unit (space, tab, NBSP, and the
/// space we substitute for empty terminal cells all count as boundaries).
bool _isSpace(int cu) => cu == 0x20 || cu == 0x09 || cu == 0xA0 || cu == 0x00;

/// A conservative absolute-URL shape: `http(s)://` + a host character + more.
/// The host char class rejects a bare `https://` or `https://.` with no host.
final RegExp _urlRe = RegExp(
  r'^https?://[^\s/$.?#][^\s]*$',
  caseSensitive: false,
);

/// Trailing punctuation that is virtually never part of a URL when it ends a
/// sentence or wraps one: `see https://x.` / `(https://x)` / `"https://x",`.
const String _trailingTrim = '.,;:!?…';

/// Closing wrappers trimmed from the end only when their opener isn't inside the
/// token — so `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its balanced `)`.
const Map<String, String> _wrappers = {')': '(', ']': '[', '}': '{', '>': '<'};

/// Returns the `http`/`https` URL occupying column [col] of [line], or `null`
/// if the tapped cell isn't inside one. [line] must be column-aligned (index ==
/// terminal column); the caller builds it from the buffer, substituting a space
/// for empty cells.
String? urlAtColumn(String line, int col) {
  if (col < 0 || col >= line.length) return null;
  if (_isSpace(line.codeUnitAt(col))) return null;

  // Expand to the whitespace-delimited token surrounding the tapped column.
  var start = col;
  var end = col;
  while (start > 0 && !_isSpace(line.codeUnitAt(start - 1))) {
    start--;
  }
  while (end < line.length - 1 && !_isSpace(line.codeUnitAt(end + 1))) {
    end++;
  }

  final token = _trimBoundary(line.substring(start, end + 1));
  return _urlRe.hasMatch(token) ? token : null;
}

/// Strips leading opener wrappers and trailing sentence punctuation / unbalanced
/// closers from a raw token, without eating characters that belong to the URL.
String _trimBoundary(String token) {
  var s = token;

  // Leading wrappers / quotes: `(https://x` , `"https://x`.
  var i = 0;
  while (i < s.length && '([{<"\''.contains(s[i])) {
    i++;
  }
  s = s.substring(i);

  // Trailing: peel punctuation and any closer whose opener isn't in the token.
  while (s.isNotEmpty) {
    final last = s[s.length - 1];
    if (_trailingTrim.contains(last) || last == '"' || last == '\'') {
      s = s.substring(0, s.length - 1);
      continue;
    }
    final opener = _wrappers[last];
    if (opener != null && !s.substring(0, s.length - 1).contains(opener)) {
      s = s.substring(0, s.length - 1);
      continue;
    }
    break;
  }
  return s;
}
