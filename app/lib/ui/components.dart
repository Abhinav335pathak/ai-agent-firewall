import 'package:flutter/material.dart';
import '../models.dart';

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
    return const Color(0xFFB33434);
  }
  if (value.contains('PENDING') ||
      value.contains('TIME') ||
      value == 'MEDIUM' ||
      value == 'EXECUTION_UNCONFIRMED') {
    return const Color(0xFF965400);
  }
  if (value.contains('ALLOW') || value.contains('APPROVED') || value == 'LOW') {
    return const Color(0xFF087F75);
  }
  return const Color(0xFF526B75);
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
        color: color.withValues(alpha: .09),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        words(text),
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
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
          Icon(icon, size: 32, color: const Color(0xFF087F75)),
          const SizedBox(height: 12),
          Text(
            title,
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFF61777F), height: 1.5),
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
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
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
                  color: Color(0xFF526B75),
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
                      color: Color(0xFF61777F),
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
