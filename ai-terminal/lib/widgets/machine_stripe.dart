import 'package:flutter/material.dart';

/// The machine stripe (#315): 3px of the machine's colour down the left edge. Nothing
/// else on the board uses a left stripe, so it can only ever mean "which machine".
class MachineStripe extends StatelessWidget {
  const MachineStripe({super.key, required this.color, required this.child});
  final Color? color;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    if (color == null) return child;
    return Stack(children: [
      child,
      Positioned(left: 0, top: 0, bottom: 0, width: 3, child: ColoredBox(color: color!)),
    ]);
  }
}
