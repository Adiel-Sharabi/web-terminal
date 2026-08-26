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

/// A paging rate for a glance — `951`, `2.6` — with no unit, so the same number
/// can carry `/s` in the readout and `page reads/sec` in the tooltip. Kept to
/// one decimal so a healthy box's 2.6 stays distinguishable from a calm 0;
/// rounding it away would erase the low end of the only pressure signal here.
String _rateShort(double v) {
  final r = (v * 10).round() / 10;
  return r == r.roundToDouble() ? '${r.round()}' : '$r';
}

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
        // Spans rather than one string, because #165 colours exactly ONE segment —
        // the absolute headroom — and leaves everything around it neutral. A line
        // where several readings can turn amber is a line nobody reads.
        final parts = <InlineSpan>[];
        void add(String text, {Color? color}) {
          if (parts.isNotEmpty) parts.add(const TextSpan(text: '  ·  '));
          parts.add(TextSpan(
            text: text,
            style: color == null ? null : TextStyle(color: color),
          ));
        }

        String tip;

        if (report == null) {
          add('CPU —  RAM —');
          tip = 'This server has not answered with resource detail';
        } else {
          final m = report.machine;
          add('CPU ${formatPctShort(m?.cpuPct)}');
          // #165 — headroom LEADS. The percentage stays as context (it is still the
          // right reading below ~90%, where it has range), but it no longer carries
          // the judgement, and the old used/total pair is gone: two byte figures plus
          // a percentage is three numbers competing for one glance.
          final avail = m?.memAvailBytes;
          if (avail != null && m?.memTotalBytes != null) {
            add(
              'RAM ${formatBytesShort(avail)} free of ${formatBytesShort(m!.memTotalBytes)}'
              '${m.memUsedPct == null ? '' : ' (${m.memUsedPct}%)'}',
              color: headroomColor(theme, avail),
            );
          } else if (m?.memUsedPct != null) {
            // A server too old to report headroom says what it DID send, rather than
            // blanking the row — and never "0 B free", which would condemn a box for
            // running an older build.
            add('RAM ${m!.memUsedPct}% '
                '(${formatBytesShort(m.memUsedBytes)} / ${formatBytesShort(m.memTotalBytes)})');
          } else {
            add('RAM —');
          }
          // The pressure figure, rendered only when it was actually measured: 0/s is
          // what a healthy box reads, so printing it for one we could not measure is a
          // claim, not a reading. No colour tier — the only data behind a threshold
          // would be one bad box against two good ones, which is the guess #165
          // refused to make silently.
          final reads = m?.memPageReadsPerSec;
          final pagingTip = reads == null || reads < 0
              ? ''
              : 'Paging: ${_rateShort(reads)} page reads/sec off disk. A high rate means '
                  'this box is short of memory and is re-reading pages it had to '
                  'evict.\n\n';
          if (reads != null && reads >= 0) add('paging ${_rateShort(reads)}/s');

          final win = (report.windowMs / 1000).round();
          if (!report.samplingOk) {
            add('WT —');
            tip = '${pagingTip}This server cannot measure processes'
                '${report.samplingReason == null ? '' : ' (${report.samplingReason})'}';
          } else {
            final wt = report.webTerminal;
            add('WT ${formatPctShort(wt?.cpuPct)} · ${formatBytesShort(wt?.rssBytes)}');
            tip = '${pagingTip}web-terminal itself — monitor, worker, web and every session below them:\n'
                '${formatPctShort(wt?.cpuPct)} of the machine over ${win < 1 ? 1 : win}s, '
                '${formatBytesShort(wt?.rssBytes)} across ${wt?.procCount ?? 0} processes.\n'
                'Whatever is left between that and the machine figure is something else on this box.';
          }
        }

        return Padding(
          padding: const EdgeInsets.only(left: 20, bottom: 2),
          child: Tooltip(
            message: tip,
            child: Text.rich(TextSpan(children: parts), style: style),
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
