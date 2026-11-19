# AI Agent Firewall

A policy-enforcement layer that sits between an AI agent and everything it is allowed to touch.
Every action the agent attempts is **intercepted, risk-scored, checked against a rulebook, and either
allowed, blocked, or sent to a human for approval**. Every decision is written to an audit log.

This repo is the complete **DevOps / CI-CD deliverable**: containers, network isolation, policy-as-code,
automated security tests, vulnerability scanning, Terraform-provisioned AWS server, auto-rollback deploys,
live metrics, and a one-command stage reset.

---

## 1. What you are building (plain English)

Think of a security guard standing between a powerful AI assistant and a company's real systems.

| Agent tries to... | Risk | Firewall does | Result on stage |
|---|---|---|---|
| `read_logs` | LOW | **Allows** automatically | Green ✅ in the feed |
| `spin_up_dev_vm` | MEDIUM | **Pauses**, asks a human | Approval card on the phone → tap Approve → a new server row appears in PostgreSQL |
| `change_iam_permissions` | HIGH | **Pauses**, asks a human | Approve / Reject |
| `delete_prod_db` | CRITICAL | **Blocks** instantly (HTTP 403) | Red ⛔, all customer rows still intact |
| anything unknown | ? | **Pauses** (fail-closed, never auto-allowed) | Human decides |

No machine learning is involved. Rules are deterministic YAML (`policy/policies.yaml`), so the same input
always gives the same verdict - exactly what a security control needs. The "agent" is a script that fires
structured JSON; a real LLM agent would use the same endpoint (see [section 13](#13-using-a-real-llm-agent-instead-of-the-script)).

### The pieces

| Component | What it is | Where it runs |
|---|---|---|
| **firewall-proxy** | Node.js/Express + Socket.IO. The brain: policy engine, approval queue, audit, metrics, live dashboard | container, public + private networks |
| **company-api-server** | The fake company's backend. Runs **real SQL** (including a real `DROP TABLE`) | container, private network only |
| **company-postgres-db** | The company's real PostgreSQL database (`customers`, `cloud_resources`, `iam_roles`) | container, private network only |
| **audit-db** | A *separate* PostgreSQL holding the append-only audit trail | container, private network only |
| **nginx** | Single public endpoint (port 80) for REST + WebSocket | container, public network |
| **agent-simulator** | Scripted "AI agent" firing the 4 scenarios | run on demand |
| **Web consoles** | Agent chat and live feed + authenticated approve/reject | browser |
| **Android app (optional future client)** | Would use the same authenticated REST/Socket.IO API; not included here | phone |

### Architecture and network isolation

```
                    PUBLIC INTERNET
   Android app ─┐         ▲
   Agent script ┼──► :80 nginx ──► firewall-proxy ──────────────┐
   Browser ─────┘   [public_net]        │                        │
                                        │ [company_private_net]  │ [audit_net]
                                        │  internal: true        │  internal: true
                                        ▼                        ▼
                               company-api-server            audit-db
                                        │
                                        ▼
                               company-postgres-db
```

* `internal: true` Docker networks have **no route to or from the outside world**.
* The agent only ever sits on `public_net`. It **cannot resolve or reach** the company API or any database.
  The firewall is the only bridge. `make isolation` proves this live.
* Only the firewall holds the credential (`INTERNAL_API_TOKEN`) the company API requires - the agent never
  sees a database password. This is the same pattern real companies use.
* On AWS the security group allows **22** (SSH), **80** (HTTP) and **443** (HTTPS). Domain/TLS activation still requires DNS and applying the Terraform change.

---

## 2. Repository layout

```
ai-agent-firewall/
├── .github/workflows/ci-cd.yml   # the whole pipeline
├── policy/policies.yaml          # THE RULEBOOK (policy-as-code, hot-reloaded)
├── firewall-proxy/               # the brain
│   ├── src/{index,policyEngine,sqlPolicy,audit,metrics}.js
│   ├── src/public/dashboard.html # live console (company DB + feed + approve buttons)
│   ├── tests/policy.test.js      # security regression tests (run in CI)
│   └── scripts/validate-policy.js
├── company-api-server/           # fake company backend + seed.sql
├── agent-simulator/simulate.js   # the scripted agent
├── agent-simulator/gemini-sql-agent.js # interactive Gemini text-to-SQL agent
├── nginx/default.conf
├── monitoring/                   # optional Prometheus + Grafana
├── terraform/                    # AWS EC2 + security group + Elastic IP
├── scripts/                      # init-env, deploy-remote, smoke-test, reset, prove-isolation
├── docker-compose.yml            # full stack (local AND production)
├── docker-compose.monitoring.yml # optional extras
├── .env.example
└── Makefile                      # shortcuts: make up / test / demo / reset
```

---

## 3. Prerequisites

Install on your laptop:

* **Git** and a **GitHub** account
* **Docker Desktop** (or Docker Engine + Compose v2)
* **Node.js 20+** (only to run tests / the simulator outside Docker)
* **Terraform ≥ 1.5** and the **AWS CLI** (`aws configure` done with an IAM user allowed to manage EC2)
* A **Docker Hub** account

---

## 4. Part A - Run everything locally (5 minutes)

Do this first. If it works here, the cloud deployment is just the same containers on a server.

```bash
cd ai-agent-firewall
make up            # = cp .env.example .env  +  docker compose up -d --build --wait
```

If port 80 is already in use, set `HTTP_PORT=8080` in `.env` and use `http://localhost:8080`.
Otherwise, open **http://localhost/company-status**. You should see the live company database (3 customers,
1 server, IAM roles) on the left and an empty firewall feed on the right.

Run the agent:

```bash
make demo          # fires the 4 scenarios, 3 s apart
```

* Scenario 1 passes straight through.
* Scenario 2 **pauses**. In the dashboard, paste the admin token (`demo-admin-token` locally) and click
  **Approve**. Watch `dev-worker-02` appear in the database table.
* Scenario 3 pauses. Click **Reject** (or do nothing - it auto-denies after 30 s).
* Scenario 4 is **blocked**. Customers are untouched.

Other useful commands:

```bash
make demo-auto     # hands-free: a robot reviewer approves the VM, rejects IAM, and asserts every result
make isolation     # proves the agent container cannot reach the company API or either database
make smoke         # black-box checks (health, enforcement, data intact, ports closed)
make reset         # restore the company DB + clear feed/audit (use before presenting)
make test          # policy validation + firewall, SQL execution and Gemini-agent unit tests
make logs          # follow logs      |  make down   # stop   |   make clean   # stop + delete data
```

> **Generate lockfiles once** (recommended, makes builds reproducible). In each of `firewall-proxy/` and
> `company-api-server/` run `npm install`, then commit the new `package-lock.json`. CI and Docker use
> `npm ci` automatically when a lockfile exists.

### Interactive Gemini text-to-SQL demo

Start the local stack with `make up`, then open `http://localhost/company-status`.
In another terminal, provide your own Gemini API key and start the agent:

```bash
export GEMINI_API_KEY='your-api-key'
export AGENT_TOKEN='your-agent-token'  # local .env default: demo-agent-token
node agent-simulator/gemini-sql-agent.js --url http://localhost
```

The CLI defaults to `gemini-3.5-flash-lite`; override with `GEMINI_MODEL`.
`GEMINI_FALLBACK_MODELS` sets a comma-separated fallback list. `--url` overrides
`FIREWALL_URL`, otherwise the CLI uses `http://localhost`. Temporary model failures
have bounded retries; firewall execution is never automatically retried. Google
credentials stay in the `x-goog-api-key` header and are never sent to the firewall.
The browser console keeps credentials in page memory only.

Try these prompts:

* **"List the customer names and plans."** Gemini submits a SELECT; the firewall
  parses its SQL structure (AST), classifies it as `sql_read`, and allows it.
* **"Change Alice Sharma's plan to Pro."** An UPDATE becomes `sql_write` and waits
  for an authenticated human decision. In the existing dashboard enter the local
  admin token `demo-admin-token`, review the complete SQL, then approve or reject. Without a decision, the
  write times out and does not execute.
* **"Drop the customers table."** The firewall classifies it as `sql_destructive`
  and blocks it before it reaches PostgreSQL.

This is deliberately a limited demo SQL interface. Only one SELECT, INSERT or
UPDATE is supported, against `customers`, `cloud_resources` or `iam_roles` in
the public schema. Safe functions are limited to COUNT, SUM, AVG, MIN, MAX,
LOWER, UPPER, LENGTH, COALESCE, NULLIF, ROUND and ABS. CTEs, SELECT INTO,
destructive statements, arbitrary functions and multiple statements fail closed.
The agent cannot bypass classification by sending its own `sql_read` label.

The private backend executes reads in a read-only transaction and writes only
after firewall approval. Extended query protocol rejects multiple commands;
statement/lock timeouts bound database work. Responses include at most 100 rows.
SQL and the decision are recorded in the existing audit feed. Gemini's final
explanation uses the actual firewall response, with tools disabled during that
explanation so it cannot issue another write.

`make test` uses mocked Gemini responses and needs no API key. CI additionally
runs the real-PostgreSQL SQL smoke test. To run that test yourself, use **only a
disposable test database**: it inserts one customer and exercises approval,
rejection, timeout, blocking and audit checks.

```bash
ADMIN_TOKEN=demo-admin-token AGENT_TOKEN=demo-agent-token ALLOW_SQL_TEST_WRITES=true \
  node scripts/sql-smoke-test.js http://localhost
```

The existing four scripted scenarios still run with `make demo-auto`.
The CLI uses Google's [generateContent REST API](https://ai.google.dev/api/generate-content).
An actual Gemini account call requires your API key and available model quota;
mock tests do not establish live Gemini acceptance.

---

## 5. Part B - The rulebook (policy-as-code)

`policy/policies.yaml` is the single source of truth:

```yaml
default_decision: REQUIRE_APPROVAL      # unknown actions fail closed
rules:
  - { action: read_logs,              risk: LOW,      decision: ALLOW }
  - { action: spin_up_dev_vm,         risk: MEDIUM,   decision: REQUIRE_APPROVAL }
  - { action: change_iam_permissions, risk: HIGH,     decision: REQUIRE_APPROVAL }
  - { action: delete_prod_db,         risk: CRITICAL, decision: BLOCK }
```

Safety rails enforced **in code and in CI**:

* `HIGH` / `CRITICAL` actions can never be `ALLOW`.
* `default_decision` can never be `ALLOW`.
* A malformed edit never takes effect: the running firewall keeps the last good policy.

**Hot reload:** the firewall re-reads the file within ~2 s, with no restart and without dropping
WebSocket connections. Try it locally: edit `policy/policies.yaml`, change `spin_up_dev_vm` to `ALLOW`,
save, run `make demo` - no pause any more. The dashboard shows a "Policy hot-reloaded" toast.

**Prove the CI safety net:** change `delete_prod_db` to `decision: ALLOW`, run `make test` → it fails
(`must not be ALLOW`). Push that in a PR and the pipeline goes red; nothing is deployed.

---

## 6. Part C - Create the GitHub repository (do NOT push yet)

1. On github.com create a new **empty** repository named `ai-agent-firewall` (no README/license).
2. Initialise locally (do not push yet - a push to `main` triggers a deploy, and your server and secrets
   don't exist yet):

```bash
cd ai-agent-firewall
git init -b main
git add .
git commit -m "Initial AI Agent Firewall"
git remote add origin https://github.com/<YOUR_USERNAME>/ai-agent-firewall.git
```

---

## 7. Part D - Provision AWS with Terraform

### 7.1 Make an SSH key (Terraform installs the public half on the server; GitHub gets the private half)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/firewall-ec2-key -N "" -C "ai-agent-firewall-deploy"
```

### 7.2 Create the server

```bash
cd terraform
terraform init
terraform plan          # read what will be created
terraform apply         # type "yes"
```

Terraform creates: an Ubuntu 24.04 EC2 instance (Docker + Compose installed on first boot, 1 GB swap,
IMDSv2 only, encrypted disk), a security group (**ports 22 and 80 only**), and an **Elastic IP** so the
address never changes when you stop/start the instance.

Copy the printed **`public_ip`** (example `13.233.xx.xx`). You need it next.

> Defaults: region `ap-south-1` (Mumbai), `t3.small`. Override with
> `terraform apply -var aws_region=us-east-1 -var instance_type=t3.micro`.
> `t3.micro` (1 GB) is enough *without* the monitoring stack.
> Cost: a running `t3.small` is roughly $15-20/month plus the Elastic IP - check the AWS pricing page
> for your region, and run `terraform destroy` when you are done.

---

## 8. Part E - Docker Hub + GitHub secrets

### 8.1 Docker Hub access token

hub.docker.com → **Account Settings → Personal access tokens → Generate new token** (Read & Write). Copy it.
The pipeline creates the repositories `firewall-proxy` and `company-api-server` on first push. Make sure they
are **public** (free-plan default for auto-created repos) - otherwise run `docker login` on the server once.

### 8.2 Add four secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `DOCKERHUB_TOKEN` | the token from 8.1 |
| `EC2_HOST` | the `public_ip` from Terraform |
| `EC2_SSH_KEY` | the **entire** contents of `~/.ssh/firewall-ec2-key` (including the `BEGIN`/`END` lines) |

With the GitHub CLI you can do it in one go:

```bash
gh secret set DOCKERHUB_USERNAME --body "<user>"
gh secret set DOCKERHUB_TOKEN    --body "<token>"
gh secret set EC2_HOST           --body "<public_ip>"
gh secret set EC2_SSH_KEY        < ~/.ssh/firewall-ec2-key
```

You do **not** create application secrets (DB passwords, admin token). The first deploy generates strong random
ones **on the server** (`scripts/init-env.sh`), so they never touch git, CI logs or Terraform state.

---

## 9. Part F - First deploy

```bash
git push -u origin main
```

Open the repo's **Actions** tab. The pipeline runs these jobs in order:

| # | Job | What it proves |
|---|---|---|
| 1 | **Policy validation & unit tests** | Rulebook is valid; critical actions stay blocked; unknown actions fail closed |
| 1 | **Terraform validate** | Infrastructure code is valid |
| 2 | **Integration test** | Boots the *entire* stack with real containers, runs the 4 scenarios with a robot reviewer, checks the database afterwards, proves network isolation |
| 3 | **Build, scan, push** | Multi-stage images built, **Trivy** fails the build on fixable CRITICAL CVEs, images pushed to Docker Hub tagged with the commit SHA + `latest` |
| 4 | **Deploy to EC2** | Uploads compose/policy/scripts, pulls the new tag, restarts, waits for every container to be healthy, **auto-rolls back** on failure, then smoke-tests the live server |

Pull requests run jobs 1-3 only (nothing is pushed or deployed).

### 9.1 Verify the live server

```bash
export HOST=<public_ip>
curl http://$HOST/health                                   # {"status":"ok",...}
curl -X POST http://$HOST/agent/execute -H 'Content-Type: application/json' -d '{"action":"read_logs"}'
curl -X POST http://$HOST/agent/execute -H 'Content-Type: application/json' -d '{"action":"delete_prod_db"}'   # 403 BLOCKED
```

Open **http://\<public_ip\>/company-status** in a browser.

### 9.2 Get your admin token (needed to approve and to reset)

```bash
ssh -i ~/.ssh/firewall-ec2-key ubuntu@$HOST 'grep ADMIN_TOKEN ~/app/.env'
```

---

## 10. Part G - Connect the Android app (contract for your teammates)

Base URL: `http://<public_ip>` (one endpoint for REST **and** WebSocket).

> **Android blocks plain HTTP by default** (API 28+). For the demo add
> `android:usesCleartextTraffic="true"` to the `<application>` tag in `AndroidManifest.xml`, or put a
> domain + HTTPS in front (see Hardening).

**Socket.IO requires `auth: { token: reviewerToken }` before it sends any history. Events the client receives** (server → app):

| Event | Payload | Use |
|---|---|---|
| `history` | array of recent entries (newest first) | fill the feed on connect |
| `pending` | array of waiting approvals | restore approval cards on reconnect |
| `approval_required` | entry with `decision: "PENDING_APPROVAL"`, `expiresAt`, `timeoutMs` | **show the Approve / Reject card** |
| `action_event` | final entry (`ALLOWED`, `BLOCKED`, `APPROVED_BY_HUMAN`, `REJECTED_BY_HUMAN`, `TIMED_OUT`, `ERROR`) | add to feed; **remove the pending card with the same `id`** |
| `feed_reset` | - | clear the feed |
| `policy_reloaded` | `{version, ruleCount, ...}` | optional toast |

Entry shape:

```json
{ "id": "uuid", "timestamp": "2026-11-17T06:30:00.000Z", "agent": "DemoAgent-01",
  "action": "spin_up_dev_vm", "target": "dev", "risk": "MEDIUM",
  "policyDecision": "REQUIRE_APPROVAL", "decision": "APPROVED_BY_HUMAN", "latencyMs": 4210.5 }
```

**To approve/reject** (app → server):

```http
POST /approval/{id}
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{ "approved": true }
```

(`404` = already decided or expired. Alternatively emit `approval_decision` `{id, approved}` over the socket,
connecting with `auth: { token: ADMIN_TOKEN }`.)

Reader endpoints require an operator Bearer token. `GET /health` alone is public; metrics also accepts its dedicated read-only `METRICS_TOKEN`.

Kotlin sketch (`io.socket:socket.io-client:2.1.0`, OkHttp):

```kotlin
val options = IO.Options().apply { auth = mapOf("token" to reviewerToken) }
val socket = IO.socket("https://<your-domain>", options)
socket.on("approval_required") { args -> val e = args[0] as JSONObject; /* show card for e.getString("id") */ }
socket.on("action_event")      { args -> val e = args[0] as JSONObject; /* add to feed, remove pending card */ }
socket.connect()

fun decide(id: String, approved: Boolean) {
    val body = """{"approved":$approved}""".toRequestBody("application/json".toMediaType())
    val req = Request.Builder().url("http://<public_ip>/approval/$id")
        .header("Authorization", "Bearer $ADMIN_TOKEN").post(body).build()
    OkHttpClient().newCall(req).enqueue(/* ... */)
}
```

This repository ships web clients; an Android app is not implemented or verified here. The web dashboard at `/company-status` does exactly the same and works as a backup on stage.

---

## 11. Part H - The stage demo

### 11.1 Before you go on (checklist)

```bash
export HOST=<public_ip>
curl http://$HOST/health                                              # healthy
ADMIN_TOKEN=<token> ./scripts/reset.sh http://$HOST                   # clean slate: DB restored, feed cleared
./scripts/smoke-test.sh http://$HOST                                  # all PASS
```

Open `http://$HOST/company-status` on the projector and the Android app on your phone (shows *Connected*).

### 11.2 The story (≈4 minutes)

1. **"This is the company."** Point at the live PostgreSQL tables: 3 customers, 1 server, `ai-agent` is a `VIEWER`.
2. **"The agent has no way in except through us."** Run `make isolation` locally, or explain that the agent only
   sits on the public network.
3. Run the agent: `node agent-simulator/simulate.js --url http://$HOST`
   * `read_logs` → green, instant.
   * `spin_up_dev_vm` → card appears on the phone → **Approve** → `dev-worker-02` appears in the table.
   * `change_iam_permissions` → card → **Reject** → role is still `VIEWER`.
   * `delete_prod_db` → red **BLOCKED** → customers still there.
4. **"Policy is code."** Show the PR where `delete_prod_db: ALLOW` turns CI red (prepare this beforehand), or show
   Grafana latency (policy decisions take well under a millisecond).
5. **Optional "what if we had no firewall?"** Pick one: on the server edit `~/app/policy/policies.yaml` so that
   `delete_prod_db` is `REQUIRE_APPROVAL`, approve it, and watch the table get destroyed (the dashboard
   turns red: *TABLE "customers" DOES NOT EXIST*). Then run `reset.sh` to restore everything in 2 seconds.
   (A server-side edit like this is overwritten by the next deploy, since git is the source of truth. A fully `ALLOW`
   rule is deliberately rejected by the validator.)

Repeat as often as you like: `reset.sh` restores the demo state in about 2 seconds.

---

## 12. Day-2 operations

| Task | How |
|---|---|
| **Change a policy** | Edit `policy/policies.yaml` → PR → merge. CI validates, deploys, the firewall hot-reloads. (The full pipeline takes several minutes - do this *before* the demo.) |
| **Instant policy change (rehearsal)** | `ssh ubuntu@$HOST`, edit `~/app/policy/policies.yaml`; live in ~2 s. Overwritten on next deploy. |
| **Roll back** | Automatic if a deploy is unhealthy. Manual: on the server set `IMAGE_TAG=<older-commit-sha>` in `~/app/.env`, then `docker compose up -d`. |
| **Logs** | `ssh ubuntu@$HOST 'cd ~/app && docker compose logs -f --tail=100'` |
| **Audit trail** | `GET /logs`, or in the DB: `docker compose exec audit-db psql -U audit -c "select ts,agent,action,risk,decision from audit_log order by seq desc limit 20;"` |
| **Metrics** | `GET /metrics` (Prometheus format): `firewall_decisions_total`, `firewall_policy_eval_seconds`, `firewall_pending_approvals` |
| **Grafana dashboard** | On the server `.env` add `COMPOSE_FILE=docker-compose.yml:docker-compose.monitoring.yml` and `GRAFANA_PASSWORD=...`, run `docker compose up -d`, then tunnel: `ssh -L 3001:localhost:3001 -i ~/.ssh/firewall-ec2-key ubuntu@$HOST` and open http://localhost:3001 (user `admin`). Dashboard *AI Agent Firewall* is pre-provisioned. |
| **Stop paying** | `cd terraform && terraform destroy` |

---

## 13. Using a real LLM agent instead of the script

You do not train anything. Give any LLM (Gemini, OpenAI, Claude, ...) tools named after your actions
(`read_logs`, `spin_up_dev_vm`, ...). When the model emits a tool call, your agent code does **not** execute
it - it sends it to the firewall:

```http
POST http://<public_ip>/agent/execute
{ "agentId": "my-agent", "action": "spin_up_dev_vm", "target": "dev", "payload": {} }
```

and returns the firewall's answer (`ALLOWED` / `APPROVED` / `BLOCKED` / `REJECTED` / `TIMED_OUT`) to the model
as the tool result. To add a new capability: add the action to `policy/policies.yaml` and an entry to the
`EXECUTORS` map in `firewall-proxy/src/index.js`.

---

## 14. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` says `set ADMIN_TOKEN in .env` | Run `make setup` (copies `.env.example` to `.env`). |
| Firewall container keeps restarting | `docker compose logs firewall-proxy`. An invalid `policy/policies.yaml` makes it refuse to start (by design). Run `make test`. |
| Deploy job: "SSH never came up" | The instance is still booting; re-run the job (`Re-run failed jobs`). Check `EC2_HOST` matches Terraform's `public_ip`. |
| Deploy job: `Permission denied (publickey)` | `EC2_SSH_KEY` must be the *private* key, whole file, matching the `.pub` Terraform installed. |
| Deploy job: `pull access denied` | Docker Hub repo is private, or `DOCKERHUB_USERNAME` is wrong. Make the repos public. |
| Trivy fails the build | A fixable CRITICAL CVE exists in a base image/dependency. Rebuild after `npm update`, or bump the base image tag. |
| Android app cannot connect | Cleartext HTTP not enabled (section 10), wrong IP, or the phone is on a network that blocks port 80. |
| Approval returns `401` | Wrong admin token. Re-read it from the server's `.env`. |
| Approval returns `404` | It already timed out (30 s) or was decided. Trigger the action again. |
| Pipeline red on a PR after editing the policy | Working as intended. Read the failing test message; it names the unsafe rule. |
| Everything stale after many practice runs | `ADMIN_TOKEN=<token> ./scripts/reset.sh http://$HOST` |

---

## 15. Security and operational boundaries

The SQL classifier parses the complete original statement, including RETURNING;
all callers are reclassified. The active HTTP gateway and real API are tested,
not just unused helper modules. SQL supports a restricted, single-statement demo
subset against the three public demo tables. The private API executes under the
non-login `firewall_sql_executor` role with SELECT/INSERT/UPDATE permissions only,
read-only transactions for reads, extended query protocol, timeouts and rollback.

Credentials and scopes:

* `AGENT_TOKEN` identifies the default `demo-agent`. `agentId` in a request cannot
  impersonate another identity. Use `AGENT_CREDENTIALS` JSON for named agents with
  `actions` and `tables` scopes; table lists contain unqualified demo table names.
* `ADMIN_TOKEN` identifies the compatibility operator `admin`. `REVIEWER_TOKENS`
  JSON maps individual reviewer names to unique tokens; audit outcomes record
  the reviewer identity. SSO/token rotation remains an organization-level extension.
* `/logs`, `/policy`, `/approvals/pending`, `/company-status.json`, reset and
  Socket.IO history are operator-only. `/metrics` accepts operators or the
  monitoring-only credential. Agent credentials cannot read those private APIs.
* All POST `/agent/execute` calls require `Authorization: Bearer <token>` and an
  `Idempotency-Key` of 8-128 letters, digits, `_`, `.`, `:`, or `-`. Reuse the same
  key only for a retry of the identical request. A different body gets 409;
  pending/interrupted requests are never automatically executed twice.

Audit intent is durable before execution. Audit/ledger outages fail closed.
Successful responses and idempotency keys survive restarts; pending approvals
are cancelled after restart. If a crash happened while execution was in progress,
its outcome is marked `EXECUTION_UNCONFIRMED`: inspect data and audit before any
manual retry. This is a **single-firewall-instance** design, not an exactly-once
transaction across two independent databases or a multi-replica queue.
Production deployments disable audit wiping. `/admin/reset` still changes the toy
company data, so only trusted operators should use it. Audit DB ownership is not
WORM protection against the database administrator; external immutable storage,
backups and retention policy remain production operational requirements.

### Public HTTPS

HTTP without TLS is for local/disposable demos only. Use a public domain with DNS
pointing to the EC2 IP, apply Terraform to open 443, and set on the server:

```dotenv
APP_DOMAIN=firewall.example.com
HTTP_BIND=127.0.0.1
HTTP_PORT=8080
COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml
```

Then run `docker compose up -d --wait`; the HTTPS overlay runs Caddy on public
80/443 while Nginx's HTTP listener binds only to loopback. Certificates and renewal
state persist in Caddy volumes. A configured APP_DOMAIN is respected by future
deploys. Public DNS and a real certificate cannot be verified without the domain.
See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
Never use certificate-warning bypasses for operator credentials.

### Verification commands

`make check` checks all JavaScript/inline-script and shell syntax. `make test`
validates policies and runs unit, real HTTP gateway, DOM and socket-auth tests.
CI additionally runs the original scenarios, SQL security checks, actual
PostgreSQL role/transaction checks, crash recovery and audit-outage recovery.
The lifecycle test deliberately requires a disposable project name:

```bash
ADMIN_TOKEN=demo-admin-token AGENT_TOKEN=demo-agent-token ALLOW_SQL_TEST_WRITES=true \
  node scripts/security-smoke-test.js http://localhost ai-agent-firewall-security-ci
```

Do not run lifecycle/SQL-write tests against the live presentation database.
Use `make smoke` for the normal authenticated, non-destructive check. Deployment
runs that check over SSH using credentials that stay on the server.

### How this maps to the real world

| This project | Enterprise equivalent |
|---|---|
| `policy/policies.yaml` | Open Policy Agent (Rego) / AWS Cedar |
| Internal Docker networks | Private subnets, security groups, mTLS |
| Android approval screen | Slack / Teams approval cards, PagerDuty |
| Audit table | SIEM (Splunk, Datadog, CloudTrail) |
| Credential held only by the firewall | Vault / AWS Secrets Manager with short-lived credentials |
| GitHub Actions + Trivy + Terraform | GitOps security pipeline |
