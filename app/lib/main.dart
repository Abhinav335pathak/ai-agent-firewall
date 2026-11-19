import 'package:flutter/material.dart';
import 'session.dart';
import 'ui/connection.dart';

void main() => runApp(const FirewallApp());

const ink = Color(0xFF142D34);
const brand = Color(0xFF087F75);

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
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: brand,
        primary: brand,
        surface: Colors.white,
      ),
      scaffoldBackgroundColor: const Color(0xFFF3F6F8),
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFFF3F6F8),
        foregroundColor: ink,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: Color(0xFFE1E8EB)),
        ),
      ),
    ),
    home: ListenableBuilder(
      listenable: session,
      builder: (context, _) => session.authenticated
          ? Scaffold(
              appBar: AppBar(title: const Text('Firewall connected')),
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(session.server.toString()),
                    Text(
                      'Policy v${session.policy['version']} · ${session.pending.length} awaiting review',
                    ),
                    Text(
                      session.live
                          ? 'Live feed connected'
                          : 'Connecting live feed…',
                    ),
                    FilledButton(
                      onPressed: session.logout,
                      child: const Text('Disconnect'),
                    ),
                  ],
                ),
              ),
            )
          : ConnectionScreen(session: session),
    ),
  );
}
