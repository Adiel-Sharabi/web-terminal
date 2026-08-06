import 'package:flutter/material.dart';

/// Thin (3dp) hairline shown under the app bar while the terminal socket is
/// disconnected (debounced ~3s — see `_showDisconnectBanner` in
/// `session_screen.dart`, so a blip that self-heals never flashes anything).
/// Quiet and non-blocking, per the accepted v2 design that replaced the old
/// modal "Reconnecting…" banner.
///
/// **It must never animate — see `test/disconnect_hairline_test.dart`.** This
/// was an indeterminate [LinearProgressIndicator], and a disconnect is
/// *unbounded*: when the server died at 22:01 the bar swept on until someone
/// noticed. One running ticker keeps the Flutter engine producing a frame every
/// vsync, so the entire window is rebuilt, rasterised and presented 60×/s to
/// move a 3px bar. Measured on a 2576×1048 window (Intel UHD 770): **14.9% GPU
/// + 6.4% DWM while disconnected, vs 6.2% + 4.1% once reconnected** — ~9% of the
/// GPU and ~7% of a CPU core burned by an indicator whose whole meaning is
/// "nothing is happening".
///
/// An indeterminate bar was the wrong widget for the job anyway: it promises
/// progress the app cannot back. The "still trying" signal is carried by the
/// `Updated <n> ago` line beneath it, which reports the thing that actually
/// matters — how stale the pane is — and costs one rebuild per minute.
class DisconnectHairline extends StatelessWidget {
  const DisconnectHairline({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      label: 'Disconnected, reconnecting',
      child: SizedBox(
        height: 3,
        width: double.infinity,
        child: ColoredBox(
          color: theme.colorScheme.error.withValues(alpha: 0.7),
        ),
      ),
    );
  }
}
