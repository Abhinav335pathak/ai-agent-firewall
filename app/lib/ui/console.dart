import 'dart:async';
import 'package:flutter/material.dart';
import '../session.dart';
import 'components.dart';
import 'details.dart';
import 'history.dart';
import 'theme.dart';

class ConsoleShell extends StatefulWidget {
  const ConsoleShell({super.key, required this.session});
  final SessionController session;
  @override
  State<ConsoleShell> createState() => _ConsoleShellState();
}

class _ConsoleShellState extends State<ConsoleShell> {
  int _tab = 0;
  String? _selected;
  late final Timer _ticker;
  final _titles = ['Overview', 'Approvals', 'History', 'Settings'];
  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker.cancel();
    super.dispose();
  }

  void _open(String id) => setState(() => _selected = id);
  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    return PopScope(
      canPop: _selected == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) setState(() => _selected = null);
      },
      child: Scaffold(
        appBar: AppBar(
          leading: _selected == null
              ? const Icon(Icons.shield_outlined, color: FirewallColors.blue)
              : BackButton(onPressed: () => setState(() => _selected = null)),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'AGENT FIREWALL',
                style: TextStyle(
                  fontSize: 11,
                  letterSpacing: 1.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
              Text(
                _selected == null ? _titles[_tab] : 'Action review',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ],
          ),
          actions: [
            IconButton(
              tooltip: 'Refresh from server',
              onPressed: session.syncing ? null : session.refresh,
              icon: const Icon(Icons.refresh),
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Column(
                children: [
                  _connectionBanner(session),
                  if (session.syncing)
                    const LinearProgressIndicator(minHeight: 2),
                  Expanded(
                    child: _selected != null
                        ? ActionDetails(session: session, id: _selected!)
                        : IndexedStack(
                            index: _tab,
                            children: [
                              _overview(session),
                              _approvals(session),
                              HistoryScreen(session: session, onOpen: _open),
                              _settings(session),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
        bottomNavigationBar: _selected != null
            ? null
            : NavigationBar(
                selectedIndex: _tab,
                onDestinationSelected: (index) => setState(() => _tab = index),
                destinations: [
                  const NavigationDestination(
                    icon: Icon(Icons.dashboard_outlined),
                    selectedIcon: Icon(Icons.dashboard),
                    label: 'Overview',
                  ),
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: session.pending.isNotEmpty,
                      label: Text('${session.pending.length}'),
                      child: const Icon(Icons.fact_check_outlined),
                    ),
                    label: 'Approvals',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.history_outlined),
                    label: 'History',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.settings_outlined),
                    label: 'Settings',
                  ),
                ],
              ),
      ),
    );
  }

  Widget _connectionBanner(SessionController s) {
    final ready = s.live && s.fresh;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(20, 8, 20, 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: (ready ? FirewallColors.green : FirewallColors.amber).withValues(
          alpha: .12,
        ),
        border: Border.all(
          color: (ready ? FirewallColors.green : FirewallColors.amber)
              .withValues(alpha: .25),
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            ready ? Icons.wifi : Icons.wifi_off,
            size: 18,
            color: ready ? FirewallColors.green : FirewallColors.amber,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              ready
                  ? 'Live · synced ${clockText(s.lastSynced)}'
                  : s.syncing
                  ? 'Syncing current server state…'
                  : 'Read-only snapshot · last sync ${clockText(s.lastSynced)}. Reconnect to review.',
              style: const TextStyle(fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _overview(SessionController s) {
    final actions = s.actions;
    final allowed = actions
        .where(
          (e) => e.decision == 'ALLOWED' || e.decision == 'APPROVED_BY_HUMAN',
        )
        .length;
    final blocked = actions.where((e) => e.decision == 'BLOCKED').length;
    return RefreshIndicator(
      onRefresh: s.refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Text(
            'Your review desk',
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w800,
              color: FirewallColors.text,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'Current requests and policy outcomes from the firewall.',
            style: TextStyle(color: FirewallColors.muted, height: 1.4),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(
                child: _stat(
                  'Awaiting review',
                  '${s.pending.length}',
                  Icons.rule,
                  FirewallColors.amber,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _stat(
                  'Recent actions',
                  '${actions.length}',
                  Icons.layers_outlined,
                  FirewallColors.text,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _stat(
                  'Executed',
                  '$allowed',
                  Icons.check_circle_outline,
                  FirewallColors.green,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _stat(
                  'Policy blocked',
                  '$blocked',
                  Icons.block,
                  FirewallColors.red,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          const Text(
            'Recent counts use unique requests within the latest 500 audit events. They are not lifetime totals.',
            style: TextStyle(
              fontSize: 11,
              color: FirewallColors.muted,
              height: 1.5,
            ),
          ),
          if (s.error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                s.error!,
                style: const TextStyle(color: FirewallColors.red),
              ),
            ),
          SectionTitle(
            'Needs your attention',
            trailing: TextButton(
              onPressed: () => setState(() => _tab = 1),
              child: const Text('View queue'),
            ),
          ),
          if (s.pending.isEmpty)
            const EmptyPanel(
              'Queue is clear',
              'New review requests appear here while this app is connected.',
            )
          else
            ...s.pending
                .take(3)
                .map(
                  (e) => ActionTile(
                    e,
                    now: DateTime.now(),
                    onTap: () => _open(e.id),
                  ),
                ),
          const SectionTitle('Recent activity'),
          if (actions.isEmpty)
            const EmptyPanel(
              'No activity yet',
              'Run an agent scenario from the CLI or web console to start the feed.',
              icon: Icons.radar,
            )
          else
            ...actions
                .take(8)
                .map((e) => ActionTile(e, onTap: () => _open(e.id))),
        ],
      ),
    );
  }

  Widget _stat(String title, String value, IconData icon, Color color) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: color),
          const SizedBox(height: 12),
          Text(
            value,
            style: TextStyle(
              fontSize: 30,
              height: 1,
              fontWeight: FontWeight.w800,
              color: color,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            title,
            style: const TextStyle(fontSize: 12, color: FirewallColors.muted),
          ),
        ],
      ),
    ),
  );

  Widget _approvals(SessionController s) => RefreshIndicator(
    onRefresh: s.refresh,
    child: ListView(
      padding: const EdgeInsets.all(20),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const Text(
          'Review before it runs',
          style: TextStyle(fontSize: 25, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        const Text(
          'Soonest expiry first. Open an action to inspect its full request. The server determines whether a review is still valid.',
          style: TextStyle(color: FirewallColors.muted, height: 1.5),
        ),
        const SizedBox(height: 20),
        if (s.pending.isEmpty)
          const EmptyPanel(
            'Nothing awaiting review',
            'Allowed actions run automatically. Blocked actions cannot be approved here.',
          )
        else
          ...s.pending.map(
            (e) => ActionTile(
              e,
              key: ValueKey('pending-${e.id}'),
              now: DateTime.now(),
              onTap: () => _open(e.id),
            ),
          ),
      ],
    ),
  );

  Widget _settings(SessionController s) => ListView(
    key: const Key('settings-list'),
    padding: const EdgeInsets.all(20),
    children: [
      const SectionTitle('Connection'),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Firewall server',
                style: TextStyle(fontSize: 12, color: FirewallColors.muted),
              ),
              const SizedBox(height: 6),
              SelectableText(
                s.server.toString(),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 16),
              Text('Last sync · ${clockText(s.lastSynced)}'),
              const SizedBox(height: 8),
              Text('Policy version · ${s.policy['version'] ?? 'unknown'}'),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: s.reconnect,
                icon: const Icon(Icons.sync),
                label: const Text('Reconnect live feed'),
              ),
            ],
          ),
        ),
      ),
      const SectionTitle('Policy rulebook'),
      const Text(
        'Read-only rules from your server. Editing policy remains a reviewed repository change.',
        style: TextStyle(color: FirewallColors.muted, fontSize: 12),
      ),
      const SizedBox(height: 12),
      for (final rule in (s.policy['rules'] as List? ?? []))
        Card(
          child: ExpansionTile(
            title: Text(words(rule['action'] as String? ?? 'unknown')),
            subtitle: Text(
              '${rule['risk']} · ${words(rule['decision'] as String? ?? 'unknown')}',
            ),
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(rule['description'] as String? ?? 'No description'),
              ),
            ],
          ),
        ),
      const SectionTitle('Session privacy'),
      const Text(
        'Credentials and history are held in memory only. Disconnecting clears this session. Closing and reopening the app requires your token again. Background push notifications are not enabled.',
        style: TextStyle(height: 1.5, color: FirewallColors.muted),
      ),
      const SizedBox(height: 20),
      FilledButton.tonalIcon(
        key: const Key('logout'),
        onPressed: s.logout,
        icon: const Icon(Icons.logout),
        label: const Padding(
          padding: EdgeInsets.all(12),
          child: Text('Disconnect & clear session'),
        ),
      ),
    ],
  );
}
