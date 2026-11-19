import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:firewall_console/session.dart';

const server = String.fromEnvironment('FIREWALL_TEST_SERVER');

Future<void> waitFor(bool Function() predicate) async {
  final deadline = DateTime.now().add(const Duration(seconds: 18));
  while (!predicate()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('Live firewall state did not converge');
    }
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

void main() {
  test(
    'Dart transport authenticates and enforces live Socket.IO approval outcomes',
    () async {
      final session = SessionController();
      final client = http.Client();
      addTearDown(session.dispose);
      addTearDown(client.close);
      await session.connect(server, 'qa-agent');
      expect(
        session.authenticated,
        false,
        reason: 'Agent credentials must not open the operator console',
      );
      await session.connect(server, 'qa-reviewer');
      expect(session.authenticated, true);
      await waitFor(() => session.live && session.fresh && !session.syncing);
      int sequence = 0;
      Future<http.Response> action(String action, String target) => client.post(
        Uri.parse('$server/agent/execute'),
        headers: {
          'Authorization': 'Bearer qa-agent',
          'Content-Type': 'application/json',
          'Idempotency-Key':
              'mobile-live-${DateTime.now().microsecondsSinceEpoch}-${sequence++}',
        },
        body: jsonEncode({'action': action, 'target': target}),
      );

      final read = await action('read_logs', 'mobile-live-read');
      expect(jsonDecode(read.body)['status'], 'ALLOWED');
      final readId = jsonDecode(read.body)['id'] as String;
      await waitFor(() => session.latest(readId)?.decision == 'ALLOWED');
      expect(session.actions.where((e) => e.id == readId).length, 1);

      final destructive = await action('delete_prod_db', 'mobile-live-block');
      expect(destructive.statusCode, 403);
      expect(jsonDecode(destructive.body)['status'], 'BLOCKED');

      for (final approved in [true, false]) {
        final target = 'mobile-live-review-$approved';
        final agentResponse = action('spin_up_dev_vm', target);
        await waitFor(() => session.pending.any((e) => e.target == target));
        final entry = session.pending.firstWhere((e) => e.target == target);
        expect(session.canDecide(entry.id), true);
        await session.decide(entry.id, approved);
        final result = await agentResponse;
        expect(
          jsonDecode(result.body)['status'],
          approved ? 'APPROVED' : 'REJECTED',
        );
        await waitFor(
          () =>
              session.latest(entry.id)?.decision ==
              (approved ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN'),
        );
      }

      final expiring = action('spin_up_dev_vm', 'mobile-live-expiry');
      await waitFor(
        () => session.pending.any((e) => e.target == 'mobile-live-expiry'),
      );
      final expiredId = session.pending
          .firstWhere((e) => e.target == 'mobile-live-expiry')
          .id;
      expect(jsonDecode((await expiring).body)['status'], 'TIMED_OUT');
      await waitFor(() => session.latest(expiredId)?.decision == 'TIMED_OUT');
      expect(session.canDecide(expiredId), false);

      session.setForeground(false);
      expect(session.live, false);
      await action('read_logs', 'mobile-live-background');
      session.setForeground(true);
      await waitFor(
        () =>
            session.live &&
            session.fresh &&
            session.actions.any((e) => e.target == 'mobile-live-background'),
      );
      session.logout();
      expect(session.events, isEmpty);
      expect(session.pending, isEmpty);
    },
    skip: server.isEmpty
        ? 'Set FIREWALL_TEST_SERVER to the disposable mobile QA gateway.'
        : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
