import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:firewall_console/main.dart';
import 'package:firewall_console/gateway.dart';
import 'package:firewall_console/models.dart';
import 'package:firewall_console/session.dart';
import 'support/fake_gateway.dart';

void main() {
  late FakeGateway gateway;
  late SessionController session;
  late DateTime now;
  const sql =
      "UPDATE customers SET email = 'reviewed@example.test' WHERE id = 1 RETURNING id, name, email";
  setUp(() {
    gateway = FakeGateway();
    now = DateTime.now();
    gateway.data = Snapshot(
      [
        event('request-1', 'PENDING_APPROVAL', sql: sql),
        event('request-1', 'INTERCEPTED', sql: sql),
        event('request-2', 'BLOCKED', sql: 'DROP TABLE customers'),
      ],
      [
        event(
          'request-1',
          'PENDING_APPROVAL',
          expiry: now.add(const Duration(minutes: 5)),
          sql: sql,
        ),
      ],
      {'version': 1, 'rules': []},
    );
    session = SessionController(factory: (_, _) => gateway, clock: () => now);
  });
  tearDown(() => session.dispose());

  Future<void> open(WidgetTester tester) async {
    await session.connect('https://example.org', 'reviewer');
    gateway.status!(FeedStatus.connected);
    await tester.pumpWidget(FirewallApp(session: session));
    await tester.pumpAndSettle();
  }

  Future<void> details(WidgetTester tester) async {
    await tester.tap(find.text('Approvals'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('pending-request-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pending-request-1')));
    await tester.pumpAndSettle();
  }

  Future<void> buttons(WidgetTester tester) async {
    await tester.scrollUntilVisible(
      find.byKey(const Key('approve-action')),
      200,
      scrollable: find
          .descendant(
            of: find.byKey(const Key('action-details')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'bad credentials stay on connect screen and do not persist token text',
    (tester) async {
      gateway.snapshotError = const GatewayException(
        'Reviewer access denied.',
        401,
      );
      await tester.pumpWidget(FirewallApp(session: session));
      await tester.enterText(
        find.byKey(const Key('server-url')),
        'https://example.org',
      );
      await tester.enterText(
        find.byKey(const Key('reviewer-token')),
        'private-token',
      );
      await tester.ensureVisible(find.byKey(const Key('connect')));
      await tester.tap(find.byKey(const Key('connect')));
      await tester.pumpAndSettle();
      expect(find.text('Reviewer access denied.'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('reviewer-token')))
            .controller!
            .text,
        isEmpty,
      );
      expect(find.text('Your review desk'), findsNothing);
    },
  );
  testWidgets(
    'overview counts requests and opens full SQL without truncation',
    (tester) async {
      await open(tester);
      expect(find.text('Your review desk'), findsOneWidget);
      await details(tester);
      expect(
        tester.widget<SelectableText>(find.byKey(const Key('full-sql'))).data,
        sql,
      );
      expect(find.text('Evaluation policy version'), findsOneWidget);
      await buttons(tester);
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('approve-action')))
            .onPressed,
        isNotNull,
      );
    },
  );
  testWidgets('reject requires confirmation and does not execute on cancel', (
    tester,
  ) async {
    await open(tester);
    await details(tester);
    await buttons(tester);
    await tester.tap(find.byKey(const Key('reject-action')));
    await tester.pumpAndSettle();
    expect(find.text('Reject this action?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(gateway.decisions, 0);
    await tester.tap(find.byKey(const Key('reject-action')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-decision')));
    await tester.pumpAndSettle();
    expect(gateway.decisions, 1);
    expect(find.byKey(const Key('approve-action')), findsNothing);
  });
  testWidgets('disconnect and local expiry disable review controls', (
    tester,
  ) async {
    await open(tester);
    await details(tester);
    await buttons(tester);
    gateway.status!(FeedStatus.disconnected);
    await tester.pump();
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('approve-action')))
          .onPressed,
      isNull,
    );
    gateway.status!(FeedStatus.connected);
    await tester.pumpAndSettle();
    now = now.add(const Duration(minutes: 6));
    await tester.pump(const Duration(seconds: 1));
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('approve-action')))
          .onPressed,
      isNull,
    );
  });
  testWidgets('history search applies to unique requests', (tester) async {
    await open(tester);
    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('history-search')), 'DROP');
    await tester.pumpAndSettle();
    expect(find.text('1 matching requests'), findsOneWidget);
    expect(find.text('DROP TABLE customers'), findsOneWidget);
  });
  testWidgets('logout removes private details including an open action', (
    tester,
  ) async {
    await open(tester);
    await details(tester);
    session.logout();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('full-sql')), findsNothing);
    expect(find.byKey(const Key('reviewer-token')), findsOneWidget);
    expect(session.actions, isEmpty);
  });
  testWidgets('small display with large text has no layout overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.4;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await open(tester);
    expect(tester.takeException(), isNull);
    await details(tester);
    await buttons(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
