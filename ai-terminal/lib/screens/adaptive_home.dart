import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/models.dart';
import '../services/session_selection.dart';
import '../widgets/empty_state.dart';
import 'dashboard_screen.dart';
import 'session_screen.dart';

/// Root screen that adapts to width. On a narrow window (phone) it is just the
/// [DashboardScreen] and tapping a session pushes a full-screen route. On a wide
/// window (desktop, tablet landscape) it becomes a master-detail split: the
/// session list as a left rail, the selected session live in the right pane.
///
/// In split mode the rail is user-resizable by dragging the divider; the chosen
/// width is the single source of truth (`_railWidth`), clamped to
/// [railMinWidth]..[railMaxWidth] and persisted so it survives restarts.
class AdaptiveHome extends StatefulWidget {
  const AdaptiveHome({super.key});

  /// Below this width we stay single-pane (phone behavior); at or above it we
  /// show the list + detail split.
  static const double splitBreakpoint = 900;

  /// Default width of the list rail in split mode (used until the user drags
  /// or a persisted width loads).
  static const double railWidth = 340;

  /// Drag clamp for the rail so it can't be dragged uselessly narrow or eat the
  /// whole window.
  static const double railMinWidth = 240;
  static const double railMaxWidth = 560;

  /// SharedPreferences key for the persisted rail width.
  static const String _railWidthPrefKey = 'wt_rail_width';

  @override
  State<AdaptiveHome> createState() => _AdaptiveHomeState();
}

class _AdaptiveHomeState extends State<AdaptiveHome> {
  final SessionSelection _selection = SessionSelection.instance;

  /// The `Session` OBJECT behind the selected id, when we happen to have one.
  ///
  /// Purely an optimisation for [SessionScreen.initialSession] so a list tap
  /// can paint immediately — the **id** in [SessionSelection] is the source of
  /// truth. A notification supplies only an id, which is why this is nullable
  /// and dropped as soon as the selection moves to an id it does not describe.
  Session? _hint;

  /// Single source of truth for the rail width. Seeded from the default, then
  /// overwritten by any persisted value, then by drags.
  double _railWidth = AdaptiveHome.railWidth;

  @override
  void initState() {
    super.initState();
    _loadRailWidth();
    _selection.selectedId.addListener(_onSelectionChanged);
  }

  @override
  void dispose() {
    _selection.selectedId.removeListener(_onSelectionChanged);
    // A torn-down split can no longer show a selection, so the notification
    // path must go back to pushing a route.
    _selection.splitMounted = false;
    super.dispose();
  }

  void _onSelectionChanged() {
    if (!mounted) return;
    setState(() {
      if (_hint?.id != _selection.selectedId.value) _hint = null;
    });
  }

  Future<void> _loadRailWidth() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getDouble(AdaptiveHome._railWidthPrefKey);
    if (saved != null && mounted) {
      setState(() => _railWidth = _clampRail(saved));
    }
  }

  double _clampRail(double w) =>
      w.clamp(AdaptiveHome.railMinWidth, AdaptiveHome.railMaxWidth);

  void _onRailDrag(double dx) {
    setState(() => _railWidth = _clampRail(_railWidth + dx));
  }

  Future<void> _persistRailWidth() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(AdaptiveHome._railWidthPrefKey, _railWidth);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= AdaptiveHome.splitBreakpoint;
        // Tell the notification path whether SELECTING is a real alternative to
        // pushing a route (#76). Written during build on purpose: it is the
        // layout decision itself, and a plain field with no listeners cannot
        // trigger the rebuild loop a notifier would.
        _selection.splitMounted = wide;
        if (!wide) {
          // Phone / narrow: the dashboard pushes routes itself.
          return const DashboardScreen();
        }
        final selectedId = _selection.selectedId.value;
        return Row(
          children: [
            SizedBox(
              width: _railWidth,
              child: DashboardScreen(
                selectedId: selectedId,
                onSelectSession: (s) {
                  _hint = s;
                  _selection.selectedId.value = s.id;
                },
              ),
            ),
            _RailResizeHandle(
              key: const Key('rail-resize-handle'),
              onDrag: _onRailDrag,
              onDragEnd: _persistRailWidth,
            ),
            Expanded(
              child: selectedId == null
                  ? const EmptyState(
                      icon: Icons.dashboard_customize_outlined,
                      title: 'Pick a session',
                      subtitle:
                          'Choose a session on the left to open it here. It stays live while you switch.',
                    )
                  // A fresh key per id rebuilds the pane (new connection) when
                  // the selection changes.
                  : SessionScreen(
                      key: ValueKey(selectedId),
                      sessionId: selectedId,
                      initialSession: _hint,
                      embedded: true,
                    ),
            ),
          ],
        );
      },
    );
  }
}

/// Draggable divider between the rail and the detail pane. Shows a resize
/// cursor, a hairline divider, and a discoverable grip; forwards horizontal
/// drag deltas to the parent (which owns the width SSOT) and signals drag-end
/// so the width can be persisted.
class _RailResizeHandle extends StatefulWidget {
  const _RailResizeHandle({
    super.key,
    required this.onDrag,
    required this.onDragEnd,
  });

  final ValueChanged<double> onDrag;
  final VoidCallback onDragEnd;

  @override
  State<_RailResizeHandle> createState() => _RailResizeHandleState();
}

class _RailResizeHandleState extends State<_RailResizeHandle> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = _hovering;
    return MouseRegion(
      cursor: SystemMouseCursors.resizeLeftRight,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onHorizontalDragUpdate: (d) => widget.onDrag(d.delta.dx),
        onHorizontalDragEnd: (_) => widget.onDragEnd(),
        child: SizedBox(
          width: 8,
          child: Center(
            child: Container(
              width: active ? 3 : 1,
              height: active ? 36 : double.infinity,
              decoration: BoxDecoration(
                color: active
                    ? theme.colorScheme.primary
                    : theme.dividerColor,
                borderRadius: active ? BorderRadius.circular(2) : null,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
