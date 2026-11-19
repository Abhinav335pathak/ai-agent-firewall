# AI Agent Firewall — Android approval console

A real Android reviewer client for the same gateway used by the web consoles and CLI agents. Application code lives in `app/lib`; Android packaging lives in `app/android`. The app package name is `firewall_console` and the Android application ID is `dev.aiagentfirewall.firewall_console`.

## Screens and flow

1. **Connect:** enter the server origin and an operator/reviewer token. Protected `/policy`, `/logs` and `/approvals/pending` requests verify access. A public `/health` response is not authentication.
2. **Overview:** connection status, pending reviews, recent unique-request counts and recent activity.
3. **Approvals:** earliest expiry first; open the full action before deciding.
4. **Action review:** full SQL, agent, target, risk, evaluated policy version when available, confirmation before approve/reject, and available audit stages.
5. **History:** search and filter recent requests by risk/outcome. The window is at most 500 audit events; intermediate stages are grouped by request ID. These are not lifetime totals or a complete per-request archive.
6. **Settings:** server, last sync, read-only policy rules, reconnect and disconnect/clear session.

The app does not generate or execute SQL itself. The backend remains responsible for classification, policy, expiry, execution and durable audit. An accepted approval is displayed separately from the final execution outcome.

## Run on Android

Use Flutter **3.38.9 / Dart 3.10.8**, JDK 17 and the Android SDK. Run `flutter doctor` to check your machine.

From the repository root:

```bash
cd app
flutter pub get --enforce-lockfile
flutter run -d <your-android-device-id>
```

For the disposable local demo, first run this in another terminal from the repository root:

```bash
npm ci --prefix firewall-proxy
node app/tool/qa-server.js
```

This starts the actual gateway on port 3300 with an in-memory audit and a mock company API. It uses only `qa-reviewer`, `qa-agent`, and `qa-internal` test credentials. It does not connect to PostgreSQL or production. Stop it with Ctrl+C.

Enter `http://10.0.2.2:3300` in an Android Studio emulator and token `qa-reviewer`. For a selected USB device, forward its port before using `http://127.0.0.1:3300`:

```bash
adb -s <your-android-device-id> reverse tcp:3300 tcp:3300
```

Remove the forward after testing:

```bash
adb -s <your-android-device-id> reverse --remove tcp:3300
```

Generate actions from another terminal (repository root):

```bash
AGENT_TOKEN=qa-agent node agent-simulator/simulate.js --url http://127.0.0.1:3300 --delay 1500
```

The default local QA approval window is 12 seconds. For a slower interactive demo start the QA server with `MOBILE_QA_APPROVAL_TIMEOUT_MS=60000`. Approve the VM request and reject the IAM change on the phone; the destructive action is blocked by policy without an approval button.

For the full containerized environment, use your gateway origin and an operator token from its configuration. The public deployment currently has no domain/certificate configured: use a debug build and disposable credentials on a trusted test network until HTTPS is active.

## Session and network behavior

- Reviewer credentials are sent only in the REST authorization header and Socket.IO auth handshake. HTTP redirects are rejected; certificate validation is not bypassed.
- Tokens and private history are held in memory, with no persistent login or disk cache. Disconnect clears both; a new process requires a new login.
- Debug Android builds allow plain HTTP for local demos. Profile/release origin validation requires HTTPS; the main manifest disables cleartext traffic.
- Socket.IO uses an authenticated WebSocket connection. Each connect/resume reconciles a protected REST snapshot; live events arriving during the snapshot are buffered and merged.
- Review buttons require a live connection, a fresh snapshot, an unexpired pending entry and no in-flight decision. There is no offline write queue or automatic approval retry.
- A 404 review response means expired/already decided; an uncertain request outcome triggers a snapshot refresh. A 401/403 clears the session. Other failures retain a read-only in-memory snapshot with a last-sync label.
- Leaving the foreground disconnects the feed. Returning reconnects and refreshes. There are no background push notifications yet.

## Verification

From `app/`:

```bash
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze --fatal-infos
flutter test --coverage --concurrency=1
flutter build apk --debug
```

With the disposable QA server running:

```bash
flutter test test/live_gateway_test.dart \
  --dart-define=FIREWALL_TEST_SERVER=http://127.0.0.1:3300
flutter test integration_test/operator_flow_test.dart -d <your-android-device-id> \
  --dart-define=FIREWALL_TEST_SERVER=http://10.0.2.2:3300
```

Use `http://127.0.0.1:3300` for a USB device with the explicit reverse rule above. The live contract test exercises real Dart REST/Socket.IO authentication, ALLOW/BLOCK, approval, rejection, timeout and foreground reconnect against the real gateway. The Android integration test drives actual widgets through login, complete SQL inspection, approve, reject, reconnect and logout. The upstream is mocked in these mobile tests; database safety is covered by the repository's existing container security workflow.

The `Android app CI` workflow runs formatting, analyzer, unit/widget tests, the live gateway contract test, APK build and the Android emulator flow. Download its `agent-firewall-demo-apk` artifact for the demo. APKs are not committed to Git.

Build output: `app/build/app/outputs/flutter-apk/app-debug.apk` (path from repository root). The generated Gradle release configuration also uses the demo debug key; configure a private release keystore before distributing a production build. The current deliverable is a debug-signed demo APK, not a Play Store release.

## Deliberately deferred

Background push delivery, persistent device login/biometrics, policy dry-run, server-paginated history and a complete per-request audit endpoint need their own backend/device work. The current timeline displays only stages present in the bounded recent feed. iOS/web platform scaffolds are not included or tested; The app source can be extended to them later.
