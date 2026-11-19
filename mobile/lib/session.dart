import 'dart:async';

import 'package:flutter/foundation.dart';
import 'gateway.dart';
import 'models.dart';

typedef GatewayFactory = Gateway Function(Uri server, String token);

/// A session generation invalidates all callbacks from old credentials. No token,
/// SQL or private history is written to disk. Offline decisions are never queued.
class SessionController extends ChangeNotifier {
  SessionController({GatewayFactory? factory, DateTime Function()? clock})
    : _factory = factory ?? ((s, t) => FirewallGateway(s, t)),
      _clock = clock ?? DateTime.now;

  final GatewayFactory _factory;
  final DateTime Function() _clock;
  Gateway? _gateway;
  int _generation = 0;
  bool _disposed = false, _syncAgain = false, _foreground = true;
  final List<FeedMessage> _buffer = [];
  final Set<String> submitting = {};
  List<ActionEvent> _events = [];
  Map<String, ActionEvent> _pending = {};
  Uri? server;
  Json policy = {};
  bool authenticated = false,
      connecting = false,
      live = false,
      syncing = false,
      fresh = false;
  String? error;
  DateTime? lastSynced;

  List<ActionEvent> get events => List.unmodifiable(_events);
  List<ActionEvent> get actions {
    final seen = <String>{};
    return _events.where((e) => seen.add(e.id)).toList();
  }

  List<ActionEvent> get pending => _pending.values.toList()
    ..sort(
      (a, b) => (a.expiresAt ?? DateTime(2100)).compareTo(
        b.expiresAt ?? DateTime(2100),
      ),
    );
  ActionEvent? pendingById(String id) => _pending[id];
  List<ActionEvent> timeline(String id) =>
      _events.where((e) => e.id == id).toList().reversed.toList();
  ActionEvent? latest(String id) {
    for (final entry in _events) {
      if (entry.id == id) return entry;
    }
    return _pending[id];
  }

  bool canDecide(String id) =>
      authenticated &&
      live &&
      fresh &&
      !syncing &&
      _foreground &&
      !submitting.contains(id) &&
      (_pending[id]?.unexpired(_clock()) ?? false);

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> connect(String address, String token) async {
    logout();
    final generation = _generation;
    connecting = true;
    _notify();
    try {
      final origin = validateServer(address);
      if (token.trim().isEmpty) {
        throw const GatewayException('Enter your reviewer token.');
      }
      final gateway = _factory(origin, token.trim());
      _gateway = gateway;
      final data = await gateway.snapshot();
      if (generation != _generation) return;
      server = origin;
      authenticated = true;
      _install(data);
      _listen(generation);
    } catch (e) {
      if (generation != _generation) return;
      _gateway?.dispose();
      _gateway = null;
      error = _message(e);
    } finally {
      if (generation == _generation) {
        connecting = false;
        _notify();
      }
    }
  }

  void _listen(int generation) {
    _gateway?.listen(
      (status) {
        if (generation != _generation) return;
        if (status == FeedStatus.authenticationFailed) {
          logout(message: 'Reviewer access expired. Connect again.');
          return;
        }
        live = status == FeedStatus.connected;
        fresh = false;
        _notify();
        if (live) unawaited(refresh());
      },
      (message) {
        if (generation != _generation || !_foreground) return;
        if (syncing) {
          _buffer.add(message);
          return;
        }
        _apply(message);
        _notify();
      },
    );
  }

  void _install(Snapshot data) {
    _events = data.events.take(500).toList();
    _pending = {for (final e in data.pending) e.id: e};
    policy = data.policy;
    lastSynced = _clock();
    fresh = true;
    error = null;
  }

  void _apply(FeedMessage message) {
    try {
      if (message.name == 'action_event') {
        final event = ActionEvent.fromJson(
          Map<String, dynamic>.from(message.data as Map),
        );
        _events.removeWhere((e) => e.eventKey == event.eventKey);
        _events.insert(0, event);
        if (_events.length > 500) _events.length = 500;
        if (event.isTerminal) _pending.remove(event.id);
      } else if (message.name == 'approval_required') {
        final entry = ActionEvent.fromJson(
          Map<String, dynamic>.from(message.data as Map),
        );
        if (!(latest(entry.id)?.isTerminal ?? false)) {
          _pending[entry.id] = entry;
        }
      } else if (message.name == 'feed_reset' ||
          message.name == 'policy_reloaded') {
        fresh = false;
        _syncAgain = true;
        if (!syncing) unawaited(refresh());
      }
    } on Object {
      fresh = false;
      error = 'Live data could not be read. Refresh before reviewing actions.';
    }
  }

  Future<void> refresh() async {
    if (_gateway == null || !authenticated || !_foreground) return;
    if (syncing) {
      _syncAgain = true;
      return;
    }
    final generation = _generation;
    syncing = true;
    fresh = false;
    _syncAgain = false;
    _notify();
    try {
      final data = await _gateway!.snapshot();
      if (generation != _generation) return;
      _install(data);
      final buffered = List<FeedMessage>.of(_buffer);
      _buffer.clear();
      for (final event in buffered) {
        _apply(event);
      }
    } catch (e) {
      if (generation != _generation) return;
      if (e is GatewayException && e.unauthorized) {
        logout(message: e.message);
        return;
      }
      // Keep the last snapshot visible, but never authorize a stale decision.
      _buffer.clear();
      error = _message(e);
      fresh = false;
    } finally {
      if (generation == _generation) {
        syncing = false;
        _notify();
        if (_syncAgain) unawaited(refresh());
      }
    }
  }

  Future<String?> decide(String id, bool approved) async {
    if (!canDecide(id)) {
      return 'Reconnect and refresh. This approval may have expired.';
    }
    final generation = _generation;
    submitting.add(id);
    _notify();
    try {
      await _gateway!.decide(id, approved);
      if (generation != _generation) return null;
      _pending.remove(
        id,
      ); // Accepted review is not proof of successful execution.
      await refresh();
      return 'Decision recorded. The audit feed shows the execution outcome.';
    } catch (e) {
      if (generation != _generation) return null;
      if (e is GatewayException && e.unauthorized) {
        logout(message: e.message);
        return e.message;
      }
      final message = _message(e);
      fresh =
          false; // Uncertain POST outcomes must be re-read, never auto-retried.
      await refresh();
      return message;
    } finally {
      if (generation == _generation) {
        submitting.remove(id);
        _notify();
      }
    }
  }

  void setForeground(bool foreground) {
    if (_foreground == foreground) return;
    _foreground = foreground;
    live = false;
    fresh = false;
    if (!foreground) {
      _gateway?.disconnectFeed();
    } else if (authenticated) {
      _listen(_generation);
    }
    _notify();
  }

  void logout({String? message}) {
    _generation++;
    _gateway?.dispose();
    _gateway = null;
    authenticated = connecting = live = syncing = fresh = false;
    _syncAgain = false;
    _buffer.clear();
    submitting.clear();
    _events.clear();
    _pending.clear();
    server = null;
    policy = {};
    lastSynced = null;
    error = message;
    _notify();
  }

  String _message(Object e) => e is GatewayException
      ? e.message
      : 'Connection failed. Check the server URL and try again.';

  @override
  void dispose() {
    _disposed = true;
    logout();
    super.dispose();
  }
}
