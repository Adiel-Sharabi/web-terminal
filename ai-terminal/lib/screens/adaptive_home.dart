import 'package:flutter/material.dart';

import '../api/models.dart';
import '../widgets/empty_state.dart';
import 'dashboard_screen.dart';
import 'session_screen.dart';

/// Root screen that adapts to width. On a narrow window (phone) it is just the
/// [DashboardScreen] and tapping a session pushes a full-screen route. On a wide
/// window (desktop, tablet landscape) it becomes a master-detail split: the
/// session list as a left rail, the selected session live in the right pane.
class AdaptiveHome extends StatefulWidget {
  const AdaptiveHome({super.key});

  /// Below this width we stay single-pane (phone behavior); at or above it we
  /// show the list + detail split.
  static const double splitBreakpoint = 900;

  /// Fixed width of the list rail in split mode.
  static const double railWidth = 340;

  @override
  State<AdaptiveHome> createState() => _AdaptiveHomeState();
}

class _AdaptiveHomeState extends State<AdaptiveHome> {
  Session? _selected;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= AdaptiveHome.splitBreakpoint;
        if (!wide) {
          // Phone / narrow: the dashboard pushes routes itself.
          return const DashboardScreen();
        }
        return Row(
          children: [
            SizedBox(
              width: AdaptiveHome.railWidth,
              child: DashboardScreen(
                selectedId: _selected?.id,
                onSelectSession: (s) => setState(() => _selected = s),
              ),
            ),
            const VerticalDivider(width: 1, thickness: 1),
            Expanded(
              child: _selected == null
                  ? const EmptyState(
                      icon: Icons.dashboard_customize_outlined,
                      title: 'Pick a session',
                      subtitle:
                          'Choose a session on the left to open it here. It stays live while you switch.',
                    )
                  // A fresh key per id rebuilds the pane (new connection) when
                  // the selection changes.
                  : SessionScreen(
                      key: ValueKey(_selected!.id),
                      sessionId: _selected!.id,
                      initialSession: _selected,
                      embedded: true,
                    ),
            ),
          ],
        );
      },
    );
  }
}
