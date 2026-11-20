import 'package:flutter/material.dart';
import '../models.dart';
import 'theme.dart';

String words(String label) => label.replaceAll('_', ' ').toLowerCase();
String clockText(DateTime? value) {
  if (value == null) return '—';
  final time = value.toLocal();
  return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}:${time.second.toString().padLeft(2, '0')}';
}

String timeLeft(ActionEvent entry, DateTime now) {
  final seconds = entry.expiresAt?.difference(now).inSeconds;
  if (seconds == null) return 'Expiry unavailable';
  if (seconds <= 0) return 'Expired · awaiting server update';
  return '${seconds}s to review';
}

Color statusColor(String value) {
  if (value.contains('BLOCK') ||
      value == 'CRITICAL' ||
      value.contains('ERROR') ||
      value == 'HIGH') {
    return FirewallColors.red;
  }
  if (value.contains('PENDING') ||
      value.contains('REJECTED') ||
      value.contains('TIME') ||
      value == 'MEDIUM' ||
      value == 'EXECUTION_UNCONFIRMED') {
    return FirewallColors.amber;
  }
  if (value.contains('ALLOW') || value.contains('APPROVED') || value == 'LOW') {
    return FirewallColors.green;
  }
  return FirewallColors.muted;
}

IconData actionIcon(String action) => switch (action) {
  'read_logs' => Icons.subject_outlined,
  'spin_up_dev_vm' => Icons.dns_outlined,
  'change_iam_permissions' => Icons.admin_panel_settings_outlined,
  'delete_prod_db' => Icons.delete_forever_outlined,
  'sql_read' => Icons.manage_search_outlined,
  'sql_write' => Icons.edit_note_outlined,
  'sql_destructive' => Icons.warning_amber_outlined,
  _ => Icons.shield_outlined,
};

IconData statusIcon(String status) {
  if (status == 'CRITICAL' || status == 'HIGH') {
    return Icons.warning_amber_outlined;
  }
  if (status == 'MEDIUM') return Icons.priority_high;
  if (status == 'LOW') return Icons.check_circle_outline;
  if (status.contains('BLOCK') || status.contains('ERROR')) return Icons.block;
  if (status.contains('REJECTED')) return Icons.cancel_outlined;
  if (status.contains('PENDING')) return Icons.schedule;
  if (status.contains('APPROVED') || status.contains('ALLOW')) {
    return Icons.check_circle_outline;
  }
  if (status.contains('TIME')) return Icons.timer_off_outlined;
  return Icons.circle_outlined;
}

class StatusPill extends StatelessWidget {
  const StatusPill(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final color = statusColor(text);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .14),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(statusIcon(text), size: 12, color: color),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              words(text),
              softWrap: true,
              style: TextStyle(
                color: color,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.trailing});
  final String title;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24, bottom: 12),
    child: Row(
      children: [
        Expanded(
          child: Text(
            title,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
          ),
        ),
        ?trailing,
      ],
    ),
  );
}

class EmptyPanel extends StatelessWidget {
  const EmptyPanel(
    this.title,
    this.message, {
    super.key,
    this.icon = Icons.check_circle_outline,
  });
  final String title, message;
  final IconData icon;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          Icon(icon, size: 32, color: FirewallColors.blue),
          const SizedBox(height: 12),
          Text(
            title,
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(color: FirewallColors.muted, height: 1.5),
          ),
        ],
      ),
    ),
  );
}

class ActionTile extends StatelessWidget {
  const ActionTile(this.entry, {super.key, required this.onTap, this.now});
  final ActionEvent entry;
  final VoidCallback onTap;
  final DateTime? now;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    margin: const EdgeInsets.only(right: 12),
                    decoration: BoxDecoration(
                      color: FirewallColors.blue.withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Icon(
                      actionIcon(entry.action),
                      color: FirewallColors.blue,
                      size: 21,
                    ),
                  ),
                  Expanded(
                    child: Text(
                      words(entry.action),
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  StatusPill(entry.risk),
                ],
              ),
              const SizedBox(height: 7),
              Text(
                entry.sql ?? entry.target,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: FirewallColors.muted,
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 10,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  StatusPill(entry.decision),
                  Text(
                    now != null
                        ? timeLeft(entry, now!)
                        : clockText(entry.timestamp),
                    style: const TextStyle(
                      fontSize: 12,
                      color: FirewallColors.muted,
                    ),
                  ),
                  Text(entry.agent, style: const TextStyle(fontSize: 12)),
                ],
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
