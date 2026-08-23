import 'package:flutter/material.dart';

import '../api/models.dart';
import '../services/resource_monitor.dart';
import 'format_utils.dart';

/// The dashboard's resource readouts (#152): one line per server group header
/// and one chip per session row.
///
/// Both widgets listen to [ResourceMonitor] directly rather than taking their
/// numbers as parameters. That keeps the rebuild to the readout itself — a
/// six-second refresh must not rebuild the whole session list — and means no
/// call site has to thread state it does not otherwise care about.
///
/// The rule both share: **a number that is not known renders as `—`, never as
/// `0`.** The server takes real trouble to keep "cannot measure" apart from
/// "idle" (a CPU figure needs two process snapshots to divide, so an honest one
/// does not exist until the second arrives), and collapsing them here would
/// throw that away — making the least-measurable server look like the emptiest,
/// which is the wrong place to start work.

/// The machine's CPU/memory plus web-terminal's own footprint, under a server
/// group header. Renders nothing at all while the view is off.
class ServerResourceLine extends StatelessWidget {
  const ServerResourceLine({super.key, required this.baseUrl});

  final String baseUrl;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: ResourceMonitor.instance,
      builder: (context, _) {
        final monitor = ResourceMonitor.instance;
        if (!monitor.enabled) return const SizedBox.shrink();

        final report = monitor[baseUrl];
        final style = theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontFeatures: const [FontFeature.tabularFigures()],
        );
        final parts = <String>[];
        String tip;

        if (report == null) {
          parts.add('CPU —  RAM —');
          tip = 'This server has not answered with resource detail';
        } else {
          final m = report.machine;
          parts.add('CPU ${formatPctShort(m?.cpuPct)}');
          if (m?.memUsedPct != null) {
            parts.add('RAM ${m!.memUsedPct}% '
                '(${formatBytesShort(m.memUsedBytes)} / ${formatBytesShort(m.memTotalBytes)})');
          } else {
            parts.add('RAM —');
          }
          final win = (report.windowMs / 1000).round();
          if (!report.samplingOk) {
            parts.add('WT —');
            tip = 'This server cannot measure processes'
                '${report.samplingReason == null ? '' : ' (${report.samplingReason})'}';
          } else {
            final wt = report.webTerminal;
            parts.add('WT ${formatPctShort(wt?.cpuPct)} · ${formatBytesShort(wt?.rssBytes)}');
            tip = 'web-terminal itself — monitor, worker, web and every session below them:\n'
                '${formatPctShort(wt?.cpuPct)} of the machine over ${win < 1 ? 1 : win}s, '
                '${formatBytesShort(wt?.rssBytes)} across ${wt?.procCount ?? 0} processes.\n'
                'Whatever is left between that and the machine figure is something else on this box.';
          }
        }

        return Padding(
          padding: const EdgeInsets.only(left: 20, bottom: 2),
          child: Tooltip(
            message: tip,
            child: Text(parts.join('  ·  '), style: style),
          ),
        );
      },
    );
  }
}

/// One session's own CPU and memory — its whole process tree, not the shell pid
/// the session reports (the agent runs several levels below it, so the shell's
/// own numbers are about a megabyte and tell you nothing).
class SessionResourceChip extends StatelessWidget {
  const SessionResourceChip({
    super.key,
    required this.baseUrl,
    required this.sessionId,
  });

  final String baseUrl;
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: ResourceMonitor.instance,
      builder: (context, _) {
        final monitor = ResourceMonitor.instance;
        if (!monitor.enabled) return const SizedBox.shrink();
        final report = monitor[baseUrl];
        // Nothing yet from this server: show nothing rather than a dash, so the
        // first seconds after switching the view on do not look like a fleet of
        // broken sessions.
        if (report == null) return const SizedBox.shrink();

        final ResourceReading? r = report.samplingOk ? report.forSession(sessionId) : null;
        final String text;
        final String tip;
        if (r == null) {
          text = '—';
          tip = report.samplingOk
              ? 'No process tree for this session'
              : 'This server cannot measure processes'
                  '${report.samplingReason == null ? '' : ' (${report.samplingReason})'}';
        } else {
          text = '${formatPctShort(r.cpuPct)} · ${formatBytesShort(r.rssBytes)}';
          final win = (report.windowMs / 1000).round();
          tip = 'CPU ${formatPctShort(r.cpuPct)} of the whole machine, averaged over '
              '${win < 1 ? 1 : win}s\n'
              'Memory ${formatBytesShort(r.rssBytes)} across ${r.procCount} '
              'process${r.procCount == 1 ? '' : 'es'}'
              '${r.topName == null ? '' : '\nLargest: ${r.topName}'}';
        }

        return Padding(
          padding: const EdgeInsets.only(left: 8),
          child: Tooltip(
            message: tip,
            child: Text(
              text,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        );
      },
    );
  }
}
