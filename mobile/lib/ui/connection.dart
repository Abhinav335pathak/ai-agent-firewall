import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../session.dart';

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({super.key, required this.session});
  final SessionController session;
  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen> {
  final _server = TextEditingController();
  final _token = TextEditingController();
  bool _obscured = true;
  @override
  void dispose() {
    _server.dispose();
    _token.clear();
    _token.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    FocusScope.of(context).unfocus();
    final token = _token.text;
    _token.clear();
    await widget.session.connect(_server.text, token);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 470),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.shield_outlined,
                  size: 48,
                  color: Color(0xFF087F75),
                ),
                const SizedBox(height: 18),
                const Text(
                  'AI AGENT FIREWALL',
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    letterSpacing: 2,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Every action.\nUnder control.',
                  style: TextStyle(
                    fontSize: 38,
                    fontWeight: FontWeight.w800,
                    height: 1.12,
                    color: Color(0xFF142D34),
                  ),
                ),
                const SizedBox(height: 14),
                const Text(
                  'Your mobile review desk. Watch agent activity, inspect risk and decide what goes through.',
                  style: TextStyle(fontSize: 16, height: 1.5),
                ),
                const SizedBox(height: 28),
                TextField(
                  key: const Key('server-url'),
                  controller: _server,
                  enabled: !widget.session.connecting,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Firewall server',
                    hintText: 'https://firewall.example.com',
                    prefixIcon: Icon(Icons.dns_outlined),
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const Key('reviewer-token'),
                  controller: _token,
                  enabled: !widget.session.connecting,
                  obscureText: _obscured,
                  autocorrect: false,
                  enableSuggestions: false,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) {
                    if (!widget.session.connecting) _connect();
                  },
                  decoration: InputDecoration(
                    labelText: 'Reviewer token',
                    prefixIcon: const Icon(Icons.key_outlined),
                    suffixIcon: IconButton(
                      tooltip: _obscured ? 'Show token' : 'Hide token',
                      onPressed: () => setState(() => _obscured = !_obscured),
                      icon: Icon(
                        _obscured
                            ? Icons.visibility_outlined
                            : Icons.visibility_off_outlined,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Use an operator token from your project administrator. Your token and action history stay in memory until you disconnect or close the app.',
                  style: TextStyle(fontSize: 12, height: 1.5),
                ),
                if (kDebugMode)
                  const Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: Text(
                      'DEBUG BUILD · HTTP is available for local demos. Use trusted networks and demo credentials only.',
                      style: TextStyle(color: Color(0xFF965400), fontSize: 12),
                    ),
                  ),
                if (widget.session.error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: Text(
                      widget.session.error!,
                      key: const Key('connection-error'),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    key: const Key('connect'),
                    onPressed: widget.session.connecting ? null : _connect,
                    icon: widget.session.connecting
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.arrow_forward),
                    label: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        widget.session.connecting
                            ? 'Connecting…'
                            : 'Connect to firewall',
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                const Text(
                  'INTERCEPT  /  REVIEW  /  AUDIT',
                  style: TextStyle(
                    letterSpacing: 1.6,
                    fontSize: 10,
                    color: Color(0xFF61777F),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
