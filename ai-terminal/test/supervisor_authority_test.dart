// #466 - which configured server the Journal page reads the supervisor from: the one
// pure rule in util/supervisor_authority.dart, every branch of it.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:ai_terminal/util/supervisor_authority.dart';
import 'package:flutter_test/flutter_test.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:1', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:1', bearerToken: 't');
const _laptop = ServerConfig(name: 'Laptop', baseUrl: 'http://l:1', bearerToken: 't');

SupervisorProbe _says(Map<String, dynamic> body) =>
    SupervisorProbe.answered(SupervisorState.fromJson(body, receivedAt: DateTime(2026))!);
SupervisorProbe _peer(String name) => _says({'role': 'peer', 'authority': {'name': name}});
final _authority = _says({'role': 'authority', 'enabled': true, 'at': 1, 'sessions': []});
final _none = _says({'role': 'none', 'authority': null});
const _down = SupervisorProbe.failed(0, 'Server unreachable');
const _old = SupervisorProbe.failed(404, 'Not found');

void main() {
  test('an authority answer is the supervisor, wherever it sits in the list', () {
    final f = findSupervisor([_home, _office, _laptop],
        {_home.baseUrl: _peer('Office'), _office.baseUrl: _authority, _laptop.baseUrl: _down});
    expect(f.kind, SupervisorFindKind.found);
    expect(f.server, _office);
    expect(f.state, same(_authority.state));
  });

  test('an authority answer wins even when no peer names it', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _none, _office.baseUrl: _authority});
    expect(f.kind, SupervisorFindKind.found);
    expect(f.server, _office);
  });

  test('an authority with its supervisor switched off says so', () {
    final f = findSupervisor([_office], {_office.baseUrl: _says({'role': 'authority', 'enabled': false})});
    expect(f.kind, SupervisorFindKind.off);
    expect(f.found, isFalse);
    expect(f.message, contains('switched off on Office'));
  });

  test('a peer names the authority case-insensitively; when it did not answer, that is said', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _peer('OFFICE'), _office.baseUrl: _down});
    expect(f.kind, SupervisorFindKind.unreachable);
    expect(f.server, _office);
    expect(f.message, "The supervisor's server (OFFICE) is not reachable: Server unreachable");
  });

  test('the named authority answering as a non-authority is unreachable, never found', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _peer('Office'), _office.baseUrl: _peer('Home')});
    expect(f.kind, SupervisorFindKind.unreachable);
    expect(f.message, contains('does not answer as the supervisor'));
  });

  test('a peer naming a server this app does not list says so', () {
    final f = findSupervisor([_home], {_home.baseUrl: _peer('Elsewhere')});
    expect(f.kind, SupervisorFindKind.notListed);
    expect(f.message, contains('(Elsewhere)'));
    expect(f.message, contains("not in this app's server list"));
  });

  test('role none, no authority or peer, and nobody silent: no lease authority is configured', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _none, _office.baseUrl: _none});
    expect(f.kind, SupervisorFindKind.noAuthority);
    expect(f.message, 'No supervisor: no lease authority is configured');
  });

  test('role none does not hide a server that failed to answer: it may be the authority', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _none, _office.baseUrl: _down});
    expect(f.kind, SupervisorFindKind.nobodyAnswered);
    expect(f.message, 'No supervisor found: Office: Server unreachable');
  });

  test('role none beside a server too old for the route is still none configured', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _none, _office.baseUrl: _old});
    expect(f.kind, SupervisorFindKind.noAuthority);
  });

  test('every server too old for the route is "not new enough", not "no authority"', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _old, _office.baseUrl: _old});
    expect(f.kind, SupervisorFindKind.unsupported);
  });

  test('nobody answering names each failure', () {
    final f = findSupervisor([_home, _office], {_home.baseUrl: _down, _office.baseUrl: _old});
    expect(f.kind, SupervisorFindKind.nobodyAnswered);
    expect(f.message, 'No supervisor found: Home: Server unreachable; Office: Not found');
  });

  test('no server configured is nobody answered, never a crash', () {
    final f = findSupervisor(const [], const {});
    expect(f.kind, SupervisorFindKind.nobodyAnswered);
    expect(f.message, isNotEmpty);
  });
}
