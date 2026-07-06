/// `StatusDot` — spec §0.5: a 10dp circle, solid for Idle/Active,
/// alpha-pulsing for Working/Waiting, pulsing + glow ring for ApiError.
library;

import 'package:flutter/material.dart';

import '../theme/status_colors.dart';

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.status, this.size = 10});

  final SessionStatus status;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = StatusColor.forStatus(status);
    final dot = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );

    switch (status) {
      case SessionStatus.waiting:
      case SessionStatus.working:
        return Pulse(child: dot);
      case SessionStatus.apiError:
        return Pulse(
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: color.withValues(alpha: 0.5),
                  blurRadius: 8,
                  spreadRadius: 1,
                ),
              ],
            ),
            child: dot,
          ),
        );
      case SessionStatus.idle:
      case SessionStatus.active:
        return dot;
    }
  }
}

/// The small server-reachability dot used in server badges/lists
/// (online/offline/needsAuth) — always solid, no pulse.
class ServerStatusDot extends StatelessWidget {
  const ServerStatusDot({super.key, required this.status, this.size = 8});

  final ServerStatus status;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: StatusColor.forServerStatus(status),
        shape: BoxShape.circle,
      ),
    );
  }
}
