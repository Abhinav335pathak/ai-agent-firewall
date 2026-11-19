import 'dart:async';
import 'package:firewall_console/gateway.dart';
import 'package:firewall_console/models.dart';

ActionEvent event(
  String id,
  String decision, {
  DateTime? expiry,
  String? sql,
}) => ActionEvent.fromJson({
  'id': id,
  'action': sql == null ? 'spin_up_dev_vm' : 'sql_write',
  'agent': 'demo-agent',
  'target': 'development',
  'risk': 'HIGH',
  'decision': decision,
  'policyDecision': 'REQUIRE_APPROVAL',
  'timestamp': '2026-11-19T10:00:00Z',
  if (expiry != null) 'expiresAt': expiry.toIso8601String(),
  'detail': {'policyVersion': 1, 'sql': ?sql},
});

class FakeGateway implements Gateway {
  Snapshot data = const Snapshot([], [], {'version': 1, 'ruleCount': 7});
  int decisions = 0;
  bool disposed = false;
  Object? snapshotError, decisionError;
  Completer<Snapshot>? snapshotWaiter;
  Completer<void>? decisionWaiter;
  void Function(FeedStatus)? status;
  void Function(FeedMessage)? message;
  @override
  Future<Snapshot> snapshot() async {
    if (snapshotError != null) throw snapshotError!;
    if (snapshotWaiter != null) return snapshotWaiter!.future;
    return data;
  }

  @override
  Future<void> decide(String id, bool approved) async {
    decisions++;
    if (decisionError != null) throw decisionError!;
    if (decisionWaiter != null) await decisionWaiter!.future;
    data = Snapshot(
      data.events,
      data.pending.where((e) => e.id != id).toList(),
      data.policy,
    );
  }

  @override
  void listen(
    void Function(FeedStatus) onStatus,
    void Function(FeedMessage) onMessage,
  ) {
    status = onStatus;
    message = onMessage;
  }

  @override
  void disconnectFeed() {
    status?.call(FeedStatus.disconnected);
  }

  @override
  void dispose() {
    disposed = true;
  }
}
