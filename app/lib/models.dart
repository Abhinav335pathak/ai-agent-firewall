typedef Json = Map<String, dynamic>;

/// Audit order comes from the server (newest first), not the agent's timestamp.
class ActionEvent {
  ActionEvent.fromJson(Json json)
    : id = json['id'] as String,
      action = json['action'] as String? ?? 'unknown',
      agent = json['agent'] as String? ?? 'unknown',
      target = json['target'] as String? ?? '',
      risk = json['risk'] as String? ?? 'UNKNOWN',
      decision = json['decision'] as String? ?? 'UNKNOWN',
      policyDecision = json['policyDecision'] as String? ?? 'UNKNOWN',
      timestamp = DateTime.tryParse(json['timestamp'] as String? ?? ''),
      expiresAt = DateTime.tryParse(json['expiresAt'] as String? ?? ''),
      latencyMs = (json['latencyMs'] as num?)?.toDouble(),
      detail = Map<String, dynamic>.from(json['detail'] as Map? ?? {}),
      sql =
          json['sql'] as String? ??
          (json['detail'] as Map?)?['sql'] as String? ??
          (json['payload'] as Map?)?['sql'] as String?;

  final String id, action, agent, target, risk, decision, policyDecision;
  final DateTime? timestamp, expiresAt;
  final double? latencyMs;
  final Json detail;
  final String? sql;

  bool get isTerminal =>
      !{'INTERCEPTED', 'PENDING_APPROVAL', 'EXECUTING'}.contains(decision);

  String get eventKey => '$id|$decision|$timestamp|$latencyMs';
  bool unexpired(DateTime now) => expiresAt?.isAfter(now) ?? false;
}

class Snapshot {
  const Snapshot(this.events, this.pending, this.policy);
  final List<ActionEvent> events, pending;
  final Json policy;
}
