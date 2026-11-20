import 'dart:convert';
import 'package:flutter/material.dart';
import '../session.dart';
import 'components.dart';
import 'theme.dart';

class ActionDetails extends StatelessWidget {
  const ActionDetails({super.key, required this.session, required this.id});
  final SessionController session;
  final String id;

  Future<void> _review(BuildContext context, bool approved) async {
    final choice = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(approved ? 'Approve this action?' : 'Reject this action?'),
        content: Text(
          approved
              ? 'The firewall will check current policy again before execution. Continue only after reviewing the full request.'
              : 'The agent will receive a rejection and this action will not execute.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('confirm-decision'),
            onPressed: () => Navigator.pop(context, true),
            child: Text(approved ? 'Confirm approval' : 'Confirm rejection'),
          ),
        ],
      ),
    );
    if (choice != true || !context.mounted) return;
    final message = await session.decide(id, approved);
    if (context.mounted && message != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = session.pendingById(id);
    final event = pending ?? session.latest(id);
    if (event == null) {
      return const Padding(
        padding: EdgeInsets.all(20),
        child: EmptyPanel(
          'Outside the recent window',
          'This request is no longer in the current snapshot. Use the server audit archive for older records.',
        ),
      );
    }
    final stages = session.timeline(id);
    final sql =
        event.sql ?? stages.map((e) => e.sql).whereType<String>().firstOrNull;
    final version = stages
        .map((e) => e.detail['policyVersion'])
        .whereType<Object>()
        .firstOrNull;
    final busy = session.submitting.contains(id);
    final enabled = session.canDecide(id);
    return ListView(
      key: const Key('action-details'),
      padding: const EdgeInsets.all(20),
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            StatusPill(event.risk),
            StatusPill(session.latest(id)?.decision ?? event.decision),
          ],
        ),
        const SizedBox(height: 18),
        Text(
          words(event.action),
          style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        SelectableText(
          id,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 11,
            color: FirewallColors.muted,
          ),
        ),
        const SectionTitle('Full request'),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _field('Agent', event.agent),
                _field('Target', event.target),
                _field('Policy decision', event.policyDecision),
                _field(
                  'Evaluation policy version',
                  version?.toString() ?? 'Unavailable in recent events',
                ),
                _field(
                  'Received',
                  event.timestamp?.toLocal().toString() ?? 'Unknown',
                ),
                if (sql != null) ...[
                  const SizedBox(height: 10),
                  const Text(
                    'Complete SQL',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 10),
                  SelectableText(
                    sql,
                    key: const Key('full-sql'),
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 13,
                      height: 1.6,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        if (pending != null) ...[
          const SectionTitle('Human review'),
          Text(
            timeLeft(pending, DateTime.now()),
            style: const TextStyle(
              fontWeight: FontWeight.w700,
              color: FirewallColors.amber,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Server expiry is final. Decisions are disabled while disconnected, refreshing or expired.',
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: FirewallColors.muted,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  key: const Key('reject-action'),
                  onPressed: enabled ? () => _review(context, false) : null,
                  icon: const Icon(Icons.close),
                  label: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('Reject'),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton.icon(
                  key: const Key('approve-action'),
                  onPressed: enabled ? () => _review(context, true) : null,
                  icon: const Icon(Icons.check),
                  label: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(busy ? 'Sending…' : 'Approve'),
                  ),
                ),
              ),
            ],
          ),
        ],
        const SectionTitle('Recent audit timeline'),
        const Text(
          'Available stages in the recent feed. A recorded approval is separate from a successful execution.',
          style: TextStyle(
            fontSize: 12,
            height: 1.5,
            color: FirewallColors.muted,
          ),
        ),
        const SizedBox(height: 12),
        if (stages.isEmpty)
          const EmptyPanel(
            'Audit stages loading',
            'Refresh the feed to load the available stages.',
          )
        else
          for (final stage in stages)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          StatusPill(stage.decision),
                          Text(
                            stage.latencyMs == null
                                ? clockText(stage.timestamp)
                                : '+${stage.latencyMs!.toStringAsFixed(0)} ms',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                      if (stage.detail.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 10),
                          child: SelectableText(
                            const JsonEncoder.withIndent(
                              '  ',
                            ).convert(stage.detail),
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 11,
                              height: 1.5,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
      ],
    );
  }

  Widget _field(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: FirewallColors.muted, fontSize: 11),
        ),
        const SizedBox(height: 4),
        SelectableText(value, style: const TextStyle(fontSize: 13)),
      ],
    ),
  );
}
