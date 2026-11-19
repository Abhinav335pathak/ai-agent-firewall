import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:firewall_console/gateway.dart';
import 'package:firewall_console/models.dart';
import 'package:firewall_console/session.dart';
import 'support/fake_gateway.dart';

Future<void> flush() => Future<void>.delayed(Duration.zero);

void main() {
  late FakeGateway gateway;
  late SessionController session;
  late DateTime now;
  setUp(() {
    gateway = FakeGateway();
    now = DateTime.utc(2026, 11, 19, 10);
    gateway.data = Snapshot(
      [event('one', 'PENDING_APPROVAL')],
      [
        event(
          'one',
          'PENDING_APPROVAL',
          expiry: now.add(const Duration(seconds: 30)),
        ),
      ],
      {'version': 1},
    );
    session = SessionController(factory: (_, _) => gateway, clock: () => now);
  });
  tearDown(() => session.dispose());
  Future<void> connected() async {
    await session.connect('https://example.org', 'reviewer');
    gateway.status!(FeedStatus.connected);
    await flush();
  }

  test('review requires a fresh snapshot AND a live connection', () async {
    await session.connect('https://example.org', 'reviewer');
    expect(session.canDecide('one'), false);
    gateway.status!(FeedStatus.connected);
    await flush();
    expect(session.canDecide('one'), true);
    gateway.status!(FeedStatus.disconnected);
    expect(session.canDecide('one'), false);
  });
  test(
    'expiration disables decisions without an offline write queue',
    () async {
      await connected();
      now = now.add(const Duration(seconds: 31));
      expect(session.canDecide('one'), false);
      await session.decide('one', true);
      expect(gateway.decisions, 0);
    },
  );
  test('duplicate taps send exactly one decision', () async {
    await connected();
    gateway.decisionWaiter = Completer<void>();
    final first = session.decide('one', true);
    await session.decide('one', true);
    expect(gateway.decisions, 1);
    gateway.decisionWaiter!.complete();
    await first;
    expect(session.pending, isEmpty);
    expect(
      session.latest('one')!.decision,
      'PENDING_APPROVAL',
    ); // No invented execution result.
  });
  test('multiple lifecycle events count as one action', () async {
    gateway.data = Snapshot(
      [
        event('one', 'ALLOWED'),
        event('one', 'EXECUTING'),
        event('one', 'INTERCEPTED'),
      ],
      [],
      {'version': 1},
    );
    await connected();
    expect(session.actions.length, 1);
    expect(session.timeline('one').map((e) => e.decision), [
      'INTERCEPTED',
      'EXECUTING',
      'ALLOWED',
    ]);
  });
  test(
    'events arriving during refresh cannot be overwritten by the snapshot',
    () async {
      await connected();
      gateway.snapshotWaiter = Completer<Snapshot>();
      final refreshing = session.refresh();
      gateway.message!(
        const FeedMessage('action_event', {
          'id': 'one',
          'decision': 'TIMED_OUT',
        }),
      );
      gateway.snapshotWaiter!.complete(gateway.data);
      await refreshing;
      expect(session.pending, isEmpty);
      expect(session.latest('one')!.decision, 'TIMED_OUT');
    },
  );
  test('late approval_required cannot reopen a terminal request', () async {
    await connected();
    gateway.message!(
      const FeedMessage('action_event', {'id': 'one', 'decision': 'CANCELLED'}),
    );
    gateway.message!(
      const FeedMessage('approval_required', {
        'id': 'one',
        'decision': 'PENDING_APPROVAL',
      }),
    );
    expect(session.pending, isEmpty);
  });
  test(
    'logout invalidates an in-flight login and clears all private data',
    () async {
      gateway.snapshotWaiter = Completer<Snapshot>();
      final connecting = session.connect('https://example.org', 'reviewer');
      session.logout();
      gateway.snapshotWaiter!.complete(gateway.data);
      await connecting;
      expect(session.authenticated, false);
      expect(session.events, isEmpty);
      expect(session.pending, isEmpty);
      expect(session.server, isNull);
      expect(gateway.disposed, true);
    },
  );
  test('old socket callbacks cannot repopulate logged-out data', () async {
    await connected();
    final callback = gateway.message!;
    session.logout();
    callback(
      const FeedMessage('action_event', {'id': 'leak', 'decision': 'ALLOWED'}),
    );
    expect(session.events, isEmpty);
  });
  test(
    '401 refresh logs out instead of showing another session private cache',
    () async {
      await connected();
      gateway.snapshotError = const GatewayException('Access denied', 401);
      await session.refresh();
      expect(session.authenticated, false);
      expect(session.events, isEmpty);
      expect(session.error, 'Access denied');
    },
  );
  test(
    'audit outage preserves labelled snapshot but prevents decisions',
    () async {
      await connected();
      gateway.snapshotError = const GatewayException('Audit unavailable', 503);
      await session.refresh();
      expect(session.events, isNotEmpty);
      expect(session.fresh, false);
      expect(session.canDecide('one'), false);
    },
  );
  test('404 decision refreshes queue and never retries the POST', () async {
    await connected();
    gateway.decisionError = const GatewayException('Already decided', 404);
    gateway.data = const Snapshot([], [], {'version': 1});
    expect(await session.decide('one', false), 'Already decided');
    expect(session.pending, isEmpty);
    expect(gateway.decisions, 1);
  });
  test(
    'background blocks approvals; foreground reconnect reconciles pending state',
    () async {
      await connected();
      session.setForeground(false);
      expect(session.canDecide('one'), false);
      gateway.data = const Snapshot([], [], {'version': 1});
      session.setForeground(true);
      gateway.status!(FeedStatus.connected);
      await flush();
      expect(session.pending, isEmpty);
      expect(session.live, true);
    },
  );
  test('socket authentication failure clears the session', () async {
    await connected();
    gateway.status!(FeedStatus.authenticationFailed);
    expect(session.authenticated, false);
    expect(session.events, isEmpty);
  });
}
