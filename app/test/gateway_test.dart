import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:firewall_console/gateway.dart';

void main() {
  test(
    'server validation requires an origin, HTTPS outside debug and no embedded secrets',
    () {
      expect(
        validateServer('https://example.org/').toString(),
        'https://example.org',
      );
      expect(
        validateServer('http://127.0.0.1:3000', allowHttp: true).port,
        3000,
      );
      for (final url in [
        'http://example.org',
        'ftp://example.org',
        'https://user:pass@example.org',
        'https://example.org/private',
        'https://example.org?token=secret',
        'https://example.org#secret',
        'wrong',
      ]) {
        expect(
          () => validateServer(url, allowHttp: false),
          throwsA(isA<GatewayException>()),
        );
      }
    },
  );
  test(
    'protected snapshot authenticates every call and does not follow redirects',
    () async {
      final paths = <String>[];
      final gateway = FirewallGateway(
        Uri.parse('https://example.org'),
        'review-secret',
        client: MockClient((request) async {
          expect(request.headers['Authorization'], 'Bearer review-secret');
          expect(request.followRedirects, false);
          paths.add(request.url.path);
          return http.Response(
            jsonEncode(request.url.path == '/policy' ? {'version': 1} : []),
            200,
          );
        }),
      );
      final data = await gateway.snapshot();
      expect(data.policy['version'], 1);
      expect(paths, ['/policy', '/logs', '/approvals/pending']);
      gateway.dispose();
    },
  );
  test('reject body is a boolean, not a truthy string', () async {
    final gateway = FirewallGateway(
      Uri.parse('https://example.org'),
      'test-token',
      client: MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/approval/request-1');
        expect(jsonDecode(request.body), {'approved': false});
        return http.Response('{}', 200);
      }),
    );
    await gateway.decide('request-1', false);
    gateway.dispose();
  });
  for (final status in [401, 403, 404, 429, 503, 302]) {
    test(
      'HTTP $status becomes a safe error without server content or secrets',
      () async {
        final gateway = FirewallGateway(
          Uri.parse('https://example.org'),
          'hidden-token',
          client: MockClient(
            (_) async =>
                http.Response('hidden-token <script>bad</script>', status),
          ),
        );
        await expectLater(
          gateway.snapshot(),
          throwsA(
            isA<GatewayException>()
                .having((e) => e.status, 'status', status)
                .having(
                  (e) => e.message.contains('hidden-token'),
                  'redaction',
                  false,
                ),
          ),
        );
        gateway.dispose();
      },
    );
  }
  test('malformed JSON is reported without leaking response body', () async {
    final gateway = FirewallGateway(
      Uri.parse('https://example.org'),
      'secret',
      client: MockClient((_) async => http.Response('<html>secret', 200)),
    );
    await expectLater(gateway.snapshot(), throwsA(isA<GatewayException>()));
    gateway.dispose();
  });
  test('malformed schema is rejected', () async {
    final gateway = FirewallGateway(
      Uri.parse('https://example.org'),
      'secret',
      client: MockClient((_) async => http.Response('{}', 200)),
    );
    await expectLater(gateway.snapshot(), throwsA(isA<GatewayException>()));
    gateway.dispose();
  });
}
