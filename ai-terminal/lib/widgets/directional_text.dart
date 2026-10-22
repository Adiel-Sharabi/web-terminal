import 'package:flutter/material.dart';

import '../util/text_direction.dart';

/// Puts [child] at the edge a [dir] paragraph starts from. A left-to-right child is
/// returned untouched, so text that was laid out before #383 still is, exactly.
Widget _atStartEdge(TextDirection dir, Widget child) => dir == TextDirection.rtl
    ? Align(alignment: Alignment.topRight, heightFactor: 1, child: child)
    : child;

/// Plain text laid out paragraph by paragraph, each in its own reading direction
/// ([textDirectionFor], #383), so a Hebrew paragraph starts at the right edge beside
/// an English one. Text whose paragraphs all read one way is a single [Text];
/// [maxLines] applies to that case and to each paragraph otherwise.
class DirectionalText extends StatelessWidget {
  const DirectionalText(this.text, {super.key, this.style, this.maxLines, this.overflow});
  final String text;
  final TextStyle? style;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  Widget build(BuildContext context) {
    final uniform = uniformDirectionOf(text);
    if (uniform != null) {
      return _atStartEdge(
          uniform, Text(text, style: style, maxLines: maxLines, overflow: overflow, textDirection: uniform));
    }
    final paras = paragraphsOf(text);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      for (final (i, p) in paras.indexed)
        Padding(
          padding: EdgeInsets.only(top: i == 0 ? 0 : 6),
          child: _atStartEdge(textDirectionFor(p),
              Text(p, style: style, maxLines: maxLines, overflow: overflow, textDirection: textDirectionFor(p))),
        ),
    ]);
  }
}

/// [build] (a markdown body, which lays its paragraphs out in the ambient
/// [Directionality]) under the reading direction of [text]: once, when every paragraph
/// reads the same way, and once per paragraph when they differ.
Widget directionalBlock(String text, Widget Function(String text) build) {
  final uniform = uniformDirectionOf(text);
  if (uniform != null) {
    return _atStartEdge(uniform, Directionality(textDirection: uniform, child: build(text)));
  }
  return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
    for (final p in paragraphsOf(text))
      _atStartEdge(textDirectionFor(p), Directionality(textDirection: textDirectionFor(p), child: build(p))),
  ]);
}
