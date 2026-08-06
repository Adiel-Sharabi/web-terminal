import 'package:flutter/material.dart';

import '../theme/pulse_clock.dart';
import '../theme/status_colors.dart';

/// Three small dots breathing out of step — the "something is happening"
/// affordance behind "Claude is working" and "Compacting conversation…".
///
/// Built out of [Pulse] deliberately. Both indicators used to hand-roll an
/// [AnimationController] driving a per-frame [Opacity]: three saveLayers every
/// vsync, and with nothing bounding the repaint it invalidated the surrounding
/// chat list. Measured on a 2576x1048 window (Intel UHD 770): **13.5% GPU +
/// 7.7% DWM** with the working bubble on screen, against 6.2% + 4.1% without
/// it — for three 6px circles.
///
/// [Pulse] already owns the cheap form of this animation (RepaintBoundary +
/// FadeTransition) and [PulseClock] owns the rate, so this keeps no third copy
/// of the rule. The stagger rides [Pulse.phase], which offsets each dot into the
/// shared breath rather than giving it a clock of its own.
class PulsingDots extends StatelessWidget {
  const PulsingDots({super.key, required this.color, this.size = 6});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(3, (i) {
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Pulse(
            phase: i / 3,
            child: Container(
              width: size,
              height: size,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          ),
        );
      }),
    );
  }
}
