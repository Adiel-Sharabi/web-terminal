// #428 - the board's view of cluster resource leases (#412): per resource, who holds it
// (machine, session, for how long, until when) and who waits behind it; and on a
// session's own card, what it holds or is waiting for. Display only: release is
// holder-only on the server, so nothing here writes.
//
// The table comes from ONE server's `GET /api/leases`, which every lease-capable server
// forwards to the lease authority. The authority's answer is the only truth about who
// holds what: when it cannot be reached the section says so and the cards say nothing,
// rather than showing an empty table or an older one as if it were current.

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import 'format_utils.dart';
import 'reason_chip.dart' show durShort;

/// One lease a session holds or waits for, with what its card needs to say about it.
class SessionLease {
  final Lease lease;

  /// For a waiter: whoever holds the resource now (null between holders).
  final Lease? holder;

  /// For a waiter: the holder's session when it is listed here, to open it.
  final Session? holderSession;

  /// How many wait for the resource.
  final int waiting;

  const SessionLease({required this.lease, this.holder, this.holderSession, this.waiting = 0});
}

/// The leases [session] holds or waits for in [table], holders first. [sessionOf] finds
/// a listed session by id (lower-case), for the waiter's link to its holder.
List<SessionLease> sessionLeases(LeaseListing? table, Session session, Session? Function(String id) sessionOf) {
  if (table == null) return const [];
  return [
    for (final l in table.forSession(session.id))
      () {
        final r = table.resourceOf(l);
        final holder = l.held ? null : r?.holder;
        final hs = holder?.sessionId;
        return SessionLease(
          lease: l,
          holder: holder,
          holderSession: hs == null ? null : sessionOf(hs),
          waiting: r?.queue.length ?? 0,
        );
      }(),
  ];
}

/// How long since [sinceMs] (`45s`, `12m`, `3h`), or empty when unknown.
String _age(int? sinceMs, DateTime now) => sinceMs == null ? '' : durShort(now.millisecondsSinceEpoch - sinceMs);

/// `for 12m`, or empty when the time is unknown.
String _forAge(int? sinceMs, DateTime now) {
  final span = _age(sinceMs, now);
  return span.isEmpty ? '' : 'for $span';
}

/// Who a lease belongs to, in words: the session's name and machine when it is listed,
/// else the machine and what is known of the holder.
String leaseHolderLabel(Lease l, Session? s) {
  final machine = l.server ?? 'unknown machine';
  if (s != null) return '${s.name} on $machine';
  if (l.sessionId == null) return '$machine · a script${l.role == null ? '' : ' (${l.role})'}, no session';
  return '$machine · session ${l.sessionId!.substring(0, l.sessionId!.length < 8 ? l.sessionId!.length : 8)}';
}

/// A link-styled holder name that opens its session; plain text when there is none.
class _HolderLink extends StatelessWidget {
  const _HolderLink({required this.label, this.session, this.onOpen, this.style, this.linkKey});
  final String label;
  final Session? session;
  final void Function(Session)? onOpen;
  final TextStyle? style;
  final Key? linkKey;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final open = onOpen;
    if (s == null || open == null) return Text(label, style: style);
    return InkWell(
      key: linkKey,
      onTap: () => open(s),
      child: Text(label,
          style: style?.copyWith(
            color: Theme.of(context).colorScheme.primary,
            decoration: TextDecoration.underline,
          )),
    );
  }
}

/// The lines on a session's card for each lease it holds or waits for.
class SessionLeaseLines extends StatelessWidget {
  const SessionLeaseLines({super.key, required this.leases, this.onOpen, this.now});
  final List<SessionLease> leases;

  /// Opens the holder's session from a waiter's line.
  final void Function(Session)? onOpen;

  /// Injectable for tests.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    final t = now ?? DateTime.now();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final sl in leases)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Wrap(
            key: ValueKey('lease-line-${sl.lease.id}'),
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 4,
            runSpacing: 2,
            children: sl.lease.held
                ? [
                    Icon(Icons.lock_outline, size: 13, color: muted?.color),
                    Text('Holds ${sl.lease.resource}', style: small?.copyWith(fontWeight: FontWeight.w600)),
                    Text(
                        [
                          _age(sl.lease.sinceMs, t),
                          if (sl.lease.expiresMs != null) 'until ${clockTime(sl.lease.expiresMs)}',
                          if (sl.waiting > 0) '${sl.waiting} waiting',
                        ].where((x) => x.isNotEmpty).join(' · '),
                        style: muted),
                  ]
                : [
                    Icon(Icons.hourglass_empty, size: 13, color: AppColors.caution),
                    Text('Waiting for ${sl.lease.resource}',
                        style: small?.copyWith(fontWeight: FontWeight.w600, color: AppColors.caution)),
                    Text(
                        [
                          '#${sl.lease.position} in line',
                          _age(sl.lease.sinceMs, t),
                          sl.holder == null ? 'being handed over' : 'held by',
                        ].where((x) => x.isNotEmpty).join(' · '),
                        style: muted),
                    if (sl.holder != null)
                      _HolderLink(
                        linkKey: ValueKey('lease-holder-link-${sl.lease.id}'),
                        label: leaseHolderLabel(sl.holder!, sl.holderSession),
                        session: sl.holderSession,
                        onOpen: onOpen,
                        style: muted,
                      ),
                  ],
          ),
        ),
    ]);
  }
}

/// The body of the board's Leases section: the table, or why it is unknown.
class LeasesPanel extends StatelessWidget {
  const LeasesPanel({
    super.key,
    required this.listing,
    required this.sessionOf,
    this.down,
    this.onOpen,
    this.now,
  });

  /// The last answer; null before one (or with [down]).
  final LeaseListing? listing;

  /// Why the table is unknown (the authority unreachable, no server to ask), or null.
  final String? down;

  /// A listed session by id (lower-case), or null.
  final Session? Function(String id) sessionOf;
  final void Function(Session)? onOpen;

  /// Injectable for tests.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall;
    final muted = small?.copyWith(color: AppColors.onSurfaceVariant);
    final t = now ?? DateTime.now();
    if (down != null) {
      return Text('Who holds what is unknown: $down',
          key: const ValueKey('leases-down'), style: small?.copyWith(color: AppColors.caution));
    }
    final table = listing;
    if (table == null) return Text('reading…', key: const ValueKey('leases-reading'), style: muted);
    final authority = table.authority == null ? null : Text('Lease authority: ${table.authority}', style: muted);
    if (table.resources.isEmpty) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Nothing is held and nobody is waiting.', key: const ValueKey('leases-empty'), style: muted),
        ?authority,
      ]);
    }
    Session? sessionFor(Lease l) => l.sessionId == null ? null : sessionOf(l.sessionId!);
    Widget who(Lease l) => _HolderLink(
          linkKey: ValueKey('lease-open-${l.id}'),
          label: leaseHolderLabel(l, sessionFor(l)),
          session: sessionFor(l),
          onOpen: onOpen,
          style: small,
        );
    // Stretched: one card per resource, as wide as the Machines cards above it.
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final r in table.resources)
        Card(
          key: ValueKey('lease-res-${r.resource}'),
          margin: const EdgeInsets.only(bottom: 6),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(r.resource, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              if (r.holder case final h?)
                Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 6, runSpacing: 2, children: [
                  Icon(Icons.lock_outline, size: 14, color: muted?.color),
                  Text('Held by', style: muted),
                  who(h),
                  Text(
                      [
                        _forAge(h.sinceMs, t),
                        if (h.expiresMs != null) 'until ${clockTime(h.expiresMs)}',
                      ].where((x) => x.isNotEmpty).join(' · '),
                      style: muted),
                ])
              else
                Text('Free - handing over to the next in line', style: muted),
              for (final w in r.queue)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 6, runSpacing: 2, children: [
                    Icon(Icons.hourglass_empty, size: 14, color: AppColors.caution),
                    Text('#${w.position} waiting', style: small?.copyWith(color: AppColors.caution)),
                    who(w),
                    if (_forAge(w.sinceMs, t).isNotEmpty) Text(_forAge(w.sinceMs, t), style: muted),
                  ]),
                ),
            ]),
          ),
        ),
      ?authority,
    ]);
  }
}
