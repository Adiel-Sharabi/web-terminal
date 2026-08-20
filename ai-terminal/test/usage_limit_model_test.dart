// Issue #137 — parsing the server's `usageLimit` block.
//
// The defaults matter more than the happy path: a server mid-upgrade, or an older
// one, sends partial or no data, and reading absence as "switched off" would show
// every capped session as abandoned.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';

void main() {
  test('parses a fully-populated block', () {
    final u = UsageLimit.fromJson({
      'waiting': true, 'armed': true, 'enabled': true,
      'resetAt': 1700000000000, 'resumeAt': 1700000060000,
    })!;
    expect(u.waiting, isTrue);
    expect(u.armed, isTrue);
    expect(u.enabled, isTrue);
    expect(u.resumeAt, 1700000060000);
  });

  test('an absent `enabled` reads as ON, not off', () {
    // Default ON is the #137 decision; a missing key must not invert it.
    expect(UsageLimit.fromJson({'waiting': true})!.enabled, isTrue);
  });

  test('an explicit false is respected', () {
    expect(UsageLimit.fromJson({'waiting': true, 'enabled': false})!.enabled, isFalse);
  });

  test('a non-map (older server sends nothing) yields null, not a default state', () {
    expect(UsageLimit.fromJson(null), isNull);
    expect(UsageLimit.fromJson('nope'), isNull);
  });

  test('Session.fromJson carries it, and tolerates its absence', () {
    const server = ServerConfig(name: 'H', baseUrl: 'http://x', bearerToken: 't');
    final withIt = Session.fromJson(server, {
      'id': 'a', 'name': 'n', 'cwd': '/c', 'status': 'idle',
      'usageLimit': {'waiting': true, 'armed': true, 'resumeAt': 123},
    });
    expect(withIt.usageLimit?.waiting, isTrue);
    expect(withIt.usageLimit?.resumeAt, 123);

    final without = Session.fromJson(server, {
      'id': 'a', 'name': 'n', 'cwd': '/c', 'status': 'idle',
    });
    expect(without.usageLimit, isNull);
  });
}
