import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:http/http.dart' as http;
import 'package:firewall_console/main.dart';
import 'package:firewall_console/session.dart';

const server = String.fromEnvironment(
  'FIREWALL_TEST_SERVER',
  defaultValue: 'http://10.0.2.2:3300',
);

Future<void> until(WidgetTester tester, bool Function() ready) async {
  final deadline = DateTime.now().add(const Duration(seconds: 30));
  while (!ready()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('Android UI did not reach the expected state');
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'operator connects, inspects SQL, approves, rejects and clears the session',
    (tester) async {
      final session = SessionController();
      final agent = http.Client();
      addTearDown(session.dispose);
      addTearDown(agent.close);
      await tester.pumpWidget(FirewallApp(session: session));
      await tester.enterText(find.byKey(const Key('server-url')), server);
      await tester.enterText(
        find.byKey(const Key('reviewer-token')),
        'qa-reviewer',
      );
      await tester.ensureVisible(find.byKey(const Key('connect')));
      await tester.tap(find.byKey(const Key('connect')));
      await until(
        tester,
        () =>
            session.authenticated &&
            session.live &&
            session.fresh &&
            !session.syncing,
      );
      expect(find.text('Your review desk'), findsOneWidget);
      int number = 0;
      for (final approved in [true, false]) {
        final sql =
            "UPDATE customers SET name = 'Mobile QA ${number++}' WHERE id = 1";
        // Only this test harness has an agent credential. The application is a
        // reviewer client and never holds an agent, Gemini or database credential.
        final result = agent.post(
          Uri.parse('$server/agent/execute'),
          headers: {
            'Authorization': 'Bearer qa-agent',
            'Content-Type': 'application/json',
            'Idempotency-Key':
                'android-ui-${DateTime.now().microsecondsSinceEpoch}',
          },
          body: jsonEncode({
            'action': 'execute_sql',
            'payload': {'sql': sql},
          }),
        );
        await until(tester, () => session.pending.any((e) => e.sql == sql));
        final id = session.pending.firstWhere((e) => e.sql == sql).id;
        await tester.tap(find.text('Approvals'));
        await tester.pumpAndSettle();
        final card = find.byKey(ValueKey('pending-$id'));
        await tester.ensureVisible(card);
        await tester.pumpAndSettle();
        await tester.tap(card);
        await tester.pumpAndSettle();
        expect(
          tester.widget<SelectableText>(find.byKey(const Key('full-sql'))).data,
          sql,
        );
        final control = find.byKey(
          Key(approved ? 'approve-action' : 'reject-action'),
        );
        await tester.scrollUntilVisible(
          control,
          200,
          scrollable: find
              .descendant(
                of: find.byKey(const Key('action-details')),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.pumpAndSettle();
        await tester.tap(control);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('confirm-decision')));
        await until(
          tester,
          () =>
              !session.pending.any((e) => e.id == id) &&
              !session.submitting.contains(id),
        );
        expect(
          jsonDecode((await result).body)['status'],
          approved ? 'APPROVED' : 'REJECTED',
        );
        await until(
          tester,
          () =>
              session.latest(id)?.decision ==
              (approved ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN'),
        );
        await tester.tap(find.byType(BackButton));
        await tester.pumpAndSettle();
      }
      session.setForeground(false);
      await tester.pump();
      expect(session.live, false);
      session.setForeground(true);
      await until(
        tester,
        () => session.live && session.fresh && !session.syncing,
      );
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('logout')),
        300,
        scrollable: find
            .descendant(
              of: find.byKey(const Key('settings-list')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.byKey(const Key('logout')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('reviewer-token')), findsOneWidget);
      expect(session.events, isEmpty);
    },
  );
}
