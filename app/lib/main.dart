import 'package:flutter/material.dart';
import 'session.dart';
import 'ui/connection.dart';
import 'ui/console.dart';
import 'ui/theme.dart';

void main() => runApp(const FirewallApp());

class FirewallApp extends StatefulWidget {
  const FirewallApp({super.key, this.session});
  final SessionController? session;
  @override
  State<FirewallApp> createState() => _FirewallAppState();
}

class _FirewallAppState extends State<FirewallApp> with WidgetsBindingObserver {
  late final SessionController session = widget.session ?? SessionController();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    session.setForeground(state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (widget.session == null) session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'AI Agent Firewall',
    debugShowCheckedModeBanner: false,
    theme: firewallTheme(),
    home: ListenableBuilder(
      listenable: session,
      builder: (context, _) => session.authenticated
          ? ConsoleShell(session: session)
          : ConnectionScreen(session: session),
    ),
  );
}
