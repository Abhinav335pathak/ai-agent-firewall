import 'package:flutter/material.dart';
import '../session.dart';
import 'components.dart';
import 'theme.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.session, required this.onOpen});
  final SessionController session;
  final void Function(String) onOpen;
  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  final _search = TextEditingController();
  String _risk = 'All';
  String _outcome = 'All';
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.toLowerCase().trim();
    final actions = widget.session.actions.where((e) {
      final match = switch (_outcome) {
        'Executed' =>
          e.decision == 'ALLOWED' || e.decision == 'APPROVED_BY_HUMAN',
        'Blocked' => e.decision == 'BLOCKED',
        'Denied' => {
          'REJECTED_BY_HUMAN',
          'TIMED_OUT',
          'CANCELLED',
        }.contains(e.decision),
        _ => true,
      };
      return match &&
          (_risk == 'All' || e.risk == _risk) &&
          '${e.action} ${e.agent} ${e.id} ${e.target} ${e.sql ?? ''}'
              .toLowerCase()
              .contains(query);
    }).toList();
    return RefreshIndicator(
      onRefresh: widget.session.refresh,
      child: ListView(
        padding: const EdgeInsets.all(20),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Text(
            'Recent request history',
            style: TextStyle(fontSize: 25, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          const Text(
            'One row per request. Open it for the available audit stages. Filters apply to the latest 500 events, not the full server archive.',
            style: TextStyle(
              color: FirewallColors.muted,
              fontSize: 12,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 18),
          TextField(
            key: const Key('history-search'),
            controller: _search,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Search actions, agents or SQL',
              prefixIcon: Icon(Icons.search),
            ),
          ),
          const SizedBox(height: 14),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final value in [
                  'All',
                  'LOW',
                  'MEDIUM',
                  'HIGH',
                  'CRITICAL',
                ])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(value == 'All' ? 'All risks' : words(value)),
                      selected: _risk == value,
                      onSelected: (_) => setState(() => _risk = value),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _outcome,
            decoration: const InputDecoration(labelText: 'Outcome'),
            items: ['All', 'Executed', 'Blocked', 'Denied']
                .map(
                  (value) => DropdownMenuItem(value: value, child: Text(value)),
                )
                .toList(),
            onChanged: (value) => setState(() => _outcome = value!),
          ),
          SectionTitle('${actions.length} matching requests'),
          if (actions.isEmpty)
            const EmptyPanel(
              'No matching actions',
              'Try another search or refresh the recent feed.',
              icon: Icons.search_off,
            )
          else
            ...actions.map(
              (e) => ActionTile(e, onTap: () => widget.onOpen(e.id)),
            ),
        ],
      ),
    );
  }
}
