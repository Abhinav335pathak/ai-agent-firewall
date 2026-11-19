import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'models.dart';

class GatewayException implements Exception {
  const GatewayException(this.message, [this.status]);
  final String message;
  final int? status;
  bool get unauthorized => status == 401 || status == 403;
  @override
  String toString() => message;
}

Uri validateServer(String value, {bool allowHttp = kDebugMode}) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      !{'https', if (allowHttp) 'http'}.contains(uri.scheme)) {
    throw const GatewayException(
      'Enter a server origin such as https://firewall.example.com. HTTP is allowed only in debug builds.',
    );
  }
  return uri.replace(path: '');
}

enum FeedStatus { connected, disconnected, authenticationFailed }

class FeedMessage {
  const FeedMessage(this.name, [this.data]);
  final String name;
  final dynamic data;
}

abstract class Gateway {
  Future<Snapshot> snapshot();
  Future<void> decide(String id, bool approved);
  void listen(
    void Function(FeedStatus) onStatus,
    void Function(FeedMessage) onMessage,
  );
  void disconnectFeed();
  void dispose();
}

class FirewallGateway implements Gateway {
  FirewallGateway(this.server, this._token, {http.Client? client})
    : _http = client ?? http.Client();

  final Uri server;
  String _token;
  final http.Client _http;
  io.Socket? _socket;

  Future<dynamic> _request(String path, {Json? body}) async {
    final request = http.Request(
      body == null ? 'GET' : 'POST',
      server.resolve(path),
    );
    request.followRedirects =
        false; // Never forward a reviewer token to a redirect.
    request.headers.addAll({
      'Authorization': 'Bearer $_token',
      'Accept': 'application/json',
    });
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    try {
      final response = await (() async {
        final stream = await _http.send(request);
        return http.Response.fromStream(stream);
      })().timeout(const Duration(seconds: 12));
      if (response.statusCode == 401 || response.statusCode == 403) {
        throw GatewayException(
          'Reviewer access denied. Reconnect with an operator token.',
          response.statusCode,
        );
      }
      if (response.statusCode == 404) {
        throw const GatewayException(
          'This request has expired or another reviewer already decided it.',
          404,
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw GatewayException(
          'Server unavailable (HTTP ${response.statusCode}). Refresh before reviewing actions.',
          response.statusCode,
        );
      }
      try {
        return jsonDecode(response.body);
      } on FormatException {
        throw const GatewayException(
          'The server returned an invalid response.',
        );
      }
    } on TimeoutException {
      throw const GatewayException(
        'Connection timed out. A submitted decision may have reached the server; refresh to confirm.',
      );
    } on http.ClientException {
      throw const GatewayException(
        'Cannot reach the firewall. Check the server and your network.',
      );
    }
  }

  @override
  Future<Snapshot> snapshot() async {
    // A protected endpoint verifies the token; /health alone is not login.
    final policy = await _request('/policy');
    final events = await _request('/logs?limit=500');
    final pending = await _request('/approvals/pending');
    try {
      return Snapshot(
        (events as List)
            .map(
              (v) => ActionEvent.fromJson(Map<String, dynamic>.from(v as Map)),
            )
            .toList(),
        (pending as List)
            .map(
              (v) => ActionEvent.fromJson(Map<String, dynamic>.from(v as Map)),
            )
            .toList(),
        Map<String, dynamic>.from(policy as Map),
      );
    } on Object {
      throw const GatewayException(
        'The server data is incompatible with this app.',
      );
    }
  }

  @override
  Future<void> decide(String id, bool approved) async {
    await _request(
      '/approval/${Uri.encodeComponent(id)}',
      body: {'approved': approved},
    );
  }

  @override
  void listen(
    void Function(FeedStatus) onStatus,
    void Function(FeedMessage) onMessage,
  ) {
    disconnectFeed();
    final socket = io.io(
      server.toString(),
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': _token})
          .disableAutoConnect()
          .enableForceNew()
          .disableMultiplex()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(5000)
          .build(),
    );
    _socket = socket;
    socket.onConnect((_) => onStatus(FeedStatus.connected));
    socket.onDisconnect((_) => onStatus(FeedStatus.disconnected));
    socket.onConnectError((error) {
      if (error.toString().contains('Operator authentication required')) {
        onStatus(FeedStatus.authenticationFailed);
      } else {
        onStatus(FeedStatus.disconnected);
      }
    });
    for (final name in [
      'action_event',
      'approval_required',
      'feed_reset',
      'policy_reloaded',
    ]) {
      socket.on(name, (data) => onMessage(FeedMessage(name, data)));
    }
    // Ignore Socket.IO's initial history/pending snapshots: the authenticated REST
    // snapshot and buffered live events are merged by SessionController instead.
    socket.connect();
  }

  @override
  void disconnectFeed() {
    _socket?.dispose();
    _socket = null;
  }

  @override
  void dispose() {
    disconnectFeed();
    _http.close();
    _token = '';
  }
}
