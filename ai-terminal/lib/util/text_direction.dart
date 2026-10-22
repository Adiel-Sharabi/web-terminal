// Which way a paragraph reads (#383): the questions inbox shows prose in Hebrew and
// English side by side, and Flutter lays a widget out in the APP's direction unless it
// is told otherwise, so a Hebrew paragraph would start at the wrong edge.

import 'package:flutter/painting.dart';

/// The direction of [text], decided by its first STRONG character, the rule the
/// Unicode bidi algorithm uses for a paragraph (P2/P3). Digits, punctuation, spaces
/// and symbols carry no direction and are skipped, so `3. ` before a Hebrew word does
/// not make it read left to right. Text with no strong character at all is LTR.
///
/// Right-to-left here is Hebrew, Arabic, Syriac, Thaana, N'Ko and the scripts after
/// them up to U+08FF, plus the Hebrew and Arabic presentation forms. Strong
/// left-to-right is any letter outside those (Latin, Greek, Cyrillic, CJK, ...).
TextDirection textDirectionFor(String text) {
  for (final r in text.runes) {
    if (_isRtl(r)) return TextDirection.rtl;
    if (_isStrongLtr(r)) return TextDirection.ltr;
  }
  return TextDirection.ltr;
}

bool _isRtl(int r) =>
    (r >= 0x0590 && r <= 0x08FF) || // Hebrew .. Arabic Extended-A
    (r >= 0xFB1D && r <= 0xFDFF) || // Hebrew and Arabic presentation forms A
    (r >= 0xFE70 && r <= 0xFEFF) || // Arabic presentation forms B
    (r >= 0x10800 && r <= 0x10FFF) || // historic RTL scripts
    (r >= 0x1E800 && r <= 0x1EFFF); // Mende Kikakui, Adlam, Arabic math

/// A letter that is not right-to-left. ASCII and Latin-1 are decided exactly; above
/// them anything that is not a known neutral block counts as a letter.
bool _isStrongLtr(int r) {
  if (r < 0x80) return (r >= 0x41 && r <= 0x5A) || (r >= 0x61 && r <= 0x7A);
  if (r < 0x100) return r >= 0xC0 && r != 0xD7 && r != 0xF7;
  if (r >= 0x2000 && r <= 0x2BFF) return false; // punctuation, symbols, arrows, shapes
  if (r >= 0x3000 && r <= 0x303F) return false; // CJK punctuation
  if (r >= 0xFE00 && r <= 0xFE6F) return false; // variation selectors, small forms
  if (r >= 0xFF00 && r <= 0xFF20) return false; // fullwidth digits and punctuation
  if (r >= 0x1F000 && r <= 0x1FFFF) return false; // emoji and pictographs
  if (r >= 0x0300 && r <= 0x036F) return false; // combining marks
  return true;
}
