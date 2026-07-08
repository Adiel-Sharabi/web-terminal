/// The running build's own version, shown in the dashboard header (issue #40)
/// so the deployed build is identifiable at a glance on each device.
///
/// SSOT: the version string is never hardcoded here. [AppVersionBadge] reads it
/// at runtime from `PackageInfo.fromPlatform()` — which is fed by pubspec.yaml's
/// `version:` — so a version bump updates the header automatically with no
/// second place to edit. The loader is split from the pure presentation
/// ([AppVersionLabel]) so the rendering is deterministically unit-testable
/// without a platform channel.
library;

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Pure presentation: renders `v{version}+{buildNumber}` in the muted header
/// style ([TextTheme.labelSmall] / `onSurfaceVariant`), matching the server
/// group headers. No async, no platform channel — directly unit-testable.
class AppVersionLabel extends StatelessWidget {
  const AppVersionLabel({
    super.key,
    required this.version,
    required this.buildNumber,
  });

  /// The semantic version, e.g. `1.6.0`.
  final String version;

  /// The build number that distinguishes deploys, e.g. `18`.
  final String buildNumber;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      'v$version+$buildNumber',
      style: theme.textTheme.labelSmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

/// Loader: reads the running build's version from [PackageInfo] once, then
/// shows [AppVersionLabel]. Renders nothing until it has loaded (and stays
/// hidden if the platform probe is unavailable, e.g. in a widget-test tree) so
/// it never blocks or reflows the header. Drop into a [SliverAppBar]'s
/// `actions`.
class AppVersionBadge extends StatefulWidget {
  const AppVersionBadge({super.key});

  @override
  State<AppVersionBadge> createState() => _AppVersionBadgeState();
}

class _AppVersionBadgeState extends State<AppVersionBadge> {
  PackageInfo? _info;

  @override
  void initState() {
    super.initState();
    // A missing/unavailable version probe must never crash the header — the
    // label is non-critical chrome, so on failure we simply stay hidden.
    PackageInfo.fromPlatform().then((info) {
      if (mounted) setState(() => _info = info);
    }).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    if (info == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 12),
      child: Center(
        child: AppVersionLabel(
          version: info.version,
          buildNumber: info.buildNumber,
        ),
      ),
    );
  }
}
