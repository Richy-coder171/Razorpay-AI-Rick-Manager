# Risk Manager Workspace

An **AI Risk Manager** system built for the **Razorpay AI Buildathon 2026 — Track 02: AI Risk Manager**. The workspace contains two deliberate implementations of the same bounded-action contract: this TypeScript full-stack application, and a stdlib-only Python orchestration package ([`risk_manager/`](./risk_manager)) that demonstrates the same contract with zero dependencies. One explained pair, not an unfinished duplicate.

| Project | Language | Description |
|---|---|---|
| [`risk-manager/`](./risk-manager) | TypeScript (Node.js + React) | Full-stack application: Express API v2, 4 risk detectors, LLM agent layer with an output guard, deterministic policy engine, idempotent action executor, hash-chained audit log, frozen evaluation datasets, and a React dashboard. |
| [`risk_manager/`](./risk_manager) | Python (stdlib-only) | Standalone orchestration package: routes events to deterministic risk tools, validates tool output, and formats bounded decisions using the same action vocabularies, ambiguity band, and escalation invariants (numeric thresholds are tuned independently — see "Threshold provenance" in the Python section). |

> `risk-manager/README.md` is retired (historical v1 write-up kept for provenance); this file is the single source of truth.

## Core Principle

> **AI recommends. Deterministic code controls. Humans handle uncertainty.**

The LLM layer never controls money, payment state, or irreversible actions. It interprets detector output and recommends one of a fixed set of **bounded actions**. A deterministic **Policy Engine** approves, rejects, or escalates; an **Agent Output Guard** rejects any LLM output that invents or drifts from detector numbers; every decision lands in an append-only, hash-chained **audit log**.

## Pipeline

```
Transaction / Order Event
          ↓
      Feature Layer
          ↓
  Independent Risk Detector (deterministic, timeout-guarded)
          ↓
    Calibrated Risk Score (detector-owned, never LLM-owned)
          ↓
  Risk Manager Agent (LLM or deterministic mock)
          ↓
  Agent Output Guard (schema + score-echo + evidence checks)
          ↓
  Policy Engine (deterministic, config-driven, 9 ordered checks)
          ↓
   ┌───────────────┬──────────────────┐
   │ Safe Action   │ Human Escalation │   ← escalation can never become approval
   └───────────────┴──────────────────┘
          ↓
  Idempotent Action Executor / Escalation
          ↓
  Hash-Chained Audit Log (append-only)
```

## Modules & Bounded Actions

| Module | Risk covered | Allowed actions |
|---|---|---|
| `fraud_spike` | Coordinated transaction-volume spikes | `auto_block_window`, `flag_for_review`, `no_action` |
| `return_risk` | COD / return losses | `allow_cod`, `require_prepaid`, `flag_for_manual_review`, `block_order` |
| `abuse_ring` | Linked accounts acting as an abuse cluster | `flag_ring_for_investigation`, `restrict_accounts_pending_review`, `no_action` |
| `chargeback` | Dispute / chargeback losses | `auto_contest_full`, `auto_contest_partial`, `draft_for_human_review`, `recommend_accept_loss` |

Irreversible actions require high confidence and a probability above the module's auto-action threshold — and the pipeline still escalates anything ambiguous. The abuse-ring action vocabulary deliberately contains **no "ban" variant** (it fails type-checking in the shared contract), so permanent bans can never be automated. Probabilities in the **0.40–0.60 ambiguity band** always escalate to a human.

---

# 1. `risk-manager/` — Full-Stack Application (v2)

## Tech Stack

- **Backend:** Node.js 18+, Express 4, TypeScript 5.5 (strict), ts-node-dev, Jest + ts-jest + supertest, Zod, pino, helmet, CORS allowlist, express-rate-limit, optional MongoDB (`mongodb` v6, JSON-file fallback), Gemini via Google's OpenAI-compatible endpoint (zero-dependency HTTPS client, `gemini-2.0-flash` default).
- **Shared contracts:** `@risk-manager/shared` (workspace `file:` dependency) — the canonical snake_case types and runtime allowlists (`MODULE_ACTION_ALLOWLIST`, `IRREVERSIBLE_ACTIONS`), imported by **both backend and frontend** so the two cannot silently drift again.
- **Frontend:** React 18 + TypeScript, Vite 5, React Router 6, Tailwind CSS 3, Recharts (volume chart on Fraud Monitor), Vitest (7 API-contract tests in `api.test.ts`; no component tests yet).
- **Orchestration:** `concurrently` runs backend + frontend with one command.

## Getting Started

### Option A — Docker Compose (one command, full stack incl. MongoDB)

```bash
cd risk-manager
docker compose up --build
```

- Frontend: **http://localhost:5173** (nginx serving the Vite build, proxying `/api` same-origin)
- Backend: **http://localhost:3001/api/health** (reports `db_driver: "mongo"`)
- MongoDB: internal service with a named volume + healthcheck; the backend
  waits for `service_healthy` before starting — this exercises the
  `MongoRepository` driver with real persistence

Compose sets `DB_DRIVER=mongo` as the default for the stack; non-Docker local
dev keeps `DB_DRIVER=file` (JSON repositories). Verified from a clean state:
`docker compose up --build` alone produces a working stack (22/22 smoke
checks incl. the populated Mongo-backed hash chain, all 9 pages, all 8
scenarios through the nginx proxy).

### Option B — local dev servers

```bash
cd risk-manager

# 1. Shared contracts first (backend + frontend both import it)
cd shared && npm install && npm run build

# 2. Backend + frontend dependencies
cd ../backend && npm install
cd ../frontend && npm install

# 3. Run both (backend :3001, frontend :5173)
cd ..
npm run dev
```

Open **http://localhost:5173** (`/api` is proxied to `http://localhost:3001`). The frontend sends `x-api-key` (from `VITE_DEMO_API_KEY`, default `demo-key`, matching the backend default) on every call.

## Hosted demo

**Status: not yet deployed** — the deployment configuration is complete and
committed (`render.yaml`, `frontend/vercel.json`, and the step-by-step
[DEPLOYMENT.md](./risk-manager/DEPLOYMENT.md): Render for the backend,
MongoDB Atlas free tier for the hosted database — required so the hash-chained
audit log actually persists on a host whose filesystem doesn't — Vercel for
the frontend with `VITE_API_BASE_URL`). The link will be added here once the
stack is stood up and `SMOKE_BASE_URL=<hosted> npm run smoke` passes 22/22
against it; until then no hosted-demo claim is made. Local dev (above) is the
authoritative demo path.

## Scripts

From `risk-manager/` (root):

| Command | What it does |
|---|---|
| `npm run dev` | Backend + frontend together |
| `npm run build` | Shared → backend (`tsc` → `dist/`) → frontend |
| `npm test` | Backend Jest suite (122 tests, coverage), then frontend Vitest (7 tests in `api.test.ts`) |
| `npm run lint` | Real typechecks: `tsc --noEmit` in backend and frontend |
| `npm run evaluate` | Fits calibration, tunes threshold, writes held-out metrics |
| `npm run generate-data` | Freezes the seeded 1500-window dataset (`-- --seed N`) |
| `npm run smoke` | **Live contract check** (below) — run before any demo |
| `npm run verify-audit` | CLI audit-chain verification (exit 1 on tamper) |

## The Smoke Test (contract regression guard)

The v1→v2 rewrite once broke the demo because the frontend and backend silently disagreed on endpoint and scenario names. `npm run smoke` (backend running) now makes that class of drift structurally loud:

- `GET /api/health`, `/api/dashboard`, `/api/policy/config`, `/api/evaluation/fraud-spike`, `/api/audit?limit=5`, `/api/audit/verify` → each expects 2xx.
- All 8 demo scenarios plus the `/replay` variant → 2xx, a produced audit record, and a `recommended_action` that is a member of that module's allowlist (imported from `@risk-manager/shared`, never hand-rolled).
- Exit non-zero and print exactly which check failed.

The same contract is pinned offline by route-level tests (`backend/src/routes/contract.test.ts`, supertest): canonical routes, auth exemptions, all 8 scenarios end-to-end with bounded actions, and a v1-style `fraud-spike` scenario name that must 400 with the available list.

## Reproducibility & repo hygiene

The evaluation numbers are checkable by anyone: the frozen datasets (`backend/data/test/train-train-v1.json`, `train-dev-v1.json`, `held-out-test-v1.json`) and their SHA-256 `manifest.json` are committed, and `npm run evaluate` regenerates `evaluation/fraud-spike/results/*` from them — the `dataset_sha256` in `metrics.json` must match the manifest. Runtime state (`backend/data/audit-log.json`, `idempotency.json`) is gitignored; the frozen datasets are explicitly **not** — a blanket `data/` ignore rule would make the published metrics unreproducible, so the `.gitignore` names the runtime files individually and carries a warning comment.

## API Reference

Base URL: `http://localhost:3001`. **Auth:** demo `x-api-key` header (`DEMO_API_KEY`, default `demo-key`; disable with `REQUIRE_API_KEY=false`). **Exempt (UI renders cold):** `/api/health`, `/api/dashboard`, `/api/policy/*`, `/api/evaluation/*`. **Rate limits:** 120 req/min on `/api`, 30 req/min on `/api/demo` and `/api/webhooks`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Liveness + `db_driver`, `llm_provider`, `payment_provider`, `fraud_spike_calibration` |
| GET | `/api/dashboard` | Canonical summary: totals, per-module aggregates, recent decisions, top flagged windows |
| GET | `/api/policy/config` | Live policy thresholds (read-only, canonical) |
| POST | `/api/risk/fraud-spike` | Full pipeline over a transaction window (Zod-validated) |
| POST | `/api/risk/return-risk` | Assess an order for COD/return risk |
| POST | `/api/risk/abuse-ring` | Score a linked-account cluster |
| POST | `/api/risk/chargeback` | Assess a dispute for contest/accept |
| GET | `/api/risk/alerts` | Last 50 escalated audit records |
| POST | `/api/agent/decision` | Any module's pipeline; body `{ module, ...module payload }` |
| GET | `/api/audit` | Audit records; filters: `module`, `action`, `confidence`, `escalated`, `failure_state`, `start_date`, `end_date`, `limit` |
| GET | `/api/audit/verify` | Hash-chain verification (200 valid / 409 tampered) |
| GET | `/api/audit/stats` | Totals, escalations, approvals, guard rejections, failures |
| GET | `/api/audit/:id` | Single record or 404 |
| GET | `/api/evaluation/fraud-spike` | Held-out metrics + confusion matrix (honest `not_evaluated` if missing) |
| POST | `/api/demo/simulate/:scenario` | `normal_traffic`, `fraud_spike`, `return_risk`, `abuse_ring`, `chargeback`, `invalid_data`, `detector_failure`, `payment_timeout` |
| POST | `/api/demo/simulate/:scenario/replay` | Fixed event id → idempotency-cache hit demo |
| GET | `/api/demo/faults` | Fault-injection flag state |
| GET | `/api/demo/audit/summary` | Audit aggregate stats |
| POST | `/api/webhooks/razorpay` | Raw-body HMAC verification + event-id idempotency; a **verified** `payment.captured`/`payment.failed` webhook is recorded as a Transaction for the Risk Manager (real integration point) |
| POST | `/api/razorpay/order` | **Creates a real ₹100 (10000 paise) test order via the Razorpay Orders API** — keys stay server-side; returns only public checkout fields (order id, amount, key_id, test_mode). Fails honestly (502) when keys are absent — never fabricates an order |
| GET | `/api/razorpay/payments` | Payments recorded from signature-verified webhooks (newest first) |
| POST | `/api/webhooks/razorpay/verify-payment` | Checkout `order_id|payment_id` HMAC verification |
| GET | `/api/webhooks/provider-mode` | mock/test/live mode banner |

## Backend v2 — What Is Actually Implemented

| Component | File | What it does |
|---|---|---|
| **Server** | `backend/src/index.ts` | Express with helmet, CORS allowlist, raw-body capture, rate limiting, demo auth, pino logging, centralized 404/500. |
| **Fraud Spike Detector** | `detectors/fraudSpike/` | 10-minute windows; trailing 30-window baseline (current window excluded; Poisson floor); combined z-score; **loads the fitted calibration + tuned threshold at startup** (`evaluation/fraud-spike/results/calibration.json`); every result carries `calibration_source: "fitted" \| "bootstrap_default"` so a silent fallback is impossible. `insufficient_data` instead of guessing. |
| **Return Risk Detector** | `detectors/returnRisk/` | Explainable weighted scorecard (base 0.10; COD +0.25, value ≥ ₹5000 +0.15, ≥2 prior returns +0.25, failed delivery +0.12, low serviceability +0.10, new customer +0.08, account age < 30d +0.05). |
| **Abuse Ring Detector** | `detectors/abuseRing/` | Union-find graph clustering over 6 shared-attribute signal types; ring score from cluster size, distinct signals, edge density; no ban action exists. Output carries the per-member `shared_attributes` (graph edges, hashed values only) + `anchor_account_id`, rendered as the cluster graph on the Abuse Rings page. |
| **Chargeback Assessor** | `detectors/chargeback/` | Win probability = reason-code base rate × evidence completeness; `missing_evidence_types` by set difference; exports the single `REQUIRED_EVIDENCE_BY_REASON` taxonomy shared with policy config. |
| **Risk Manager Agent** | `agents/riskManagerAgent/` | Interprets detector output via LLM (MockProvider default; Gemini when configured — Google AI Studio key, OpenAI-compatible endpoint, zero-dependency HTTPS client, `gemini-2.0-flash` default). Skipped entirely on detector failure — deterministic escalation instead. Mock fallback on any LLM failure (`llm_unavailable`). |
| **Agent Output Guard** | `agents/riskManagerAgent/agentOutputGuard.ts` | Rejects: schema violations, probability drift beyond 2 decimals, confidence mismatch, fabricated evidence ids, actions outside the module allowlist. |
| **Policy Engine** | `policy/engine.ts` + `policy.config.json` | Nine ordered checks (kill switch, detector failure, confidence, ambiguity band, allowlist, irreversible threshold, hourly rate caps, required evidence, approval), each recorded in `checks_run`. Chargeback `required_evidence` is populated **per reason code** from the detector's taxonomy, and the container wires `getMissingEvidence` so check 8 is live. One-directional: escalation can never become approval. |
| **Action Executor** | `execution/actionExecutor.ts` | Idempotency-keyed, timeout, probe-downstream-then-retry-once, escalate on double failure. Allowlist re-checked as the last line of defense. Downstream call remains a documented test-mode stub. |
| **Audit Service** | `audit/auditService.ts` | Append-only, hash-chained (`sha256(prev_hash + canonical(record))`), monotonic `seq`, tamper verification, aggregate stats. Records now include the **idempotency key** for every executed/escalated action. |
| **Repositories** | `models/repository.ts` | `JsonFileRepository` (atomic writes, local default) or `MongoRepository` via `DB_DRIVER=mongo` — **exercised for real by the Docker Compose stack** (both drivers produce byte-identical hash chains; the `undefined`→`null` serialization divergence is stripped pre-insert and regression-tested). No update/delete — append-only by construction. |
| **Razorpay Layer** | `razorpay/` | Real HMAC-SHA256 webhook verification over raw bytes, checkout signature verification, event-id idempotency. No outbound Razorpay REST calls (`blockWindow` is a documented stub). |
| **Risk Pipeline** | `services/riskPipeline.ts` | Detector (timeout-guarded) → agent → guard → policy → execution/escalation → audit. Never throws; every failure escalates with a precise `failure_state`. |
| **Data Generator** | `data/generator.ts` + `generate-data.ts` | Seeded (mulberry32) merchants with Poisson traffic and diurnal patterns; spikes 3–7× with attacker concentration; supports custom merchant profiles (`extraProfiles`) — the demo merchant has its own. `npm run generate-data -- --seed 42` freezes a 1500-window timeline (60/20/20 chronological split) with a SHA-256 manifest. |
| **Evaluation Harness** | `evaluation/` | Fits logistic calibration on TRAIN, tunes the threshold on DEV, reports on held-out TEST: precision/recall/F1/FPR/FNR/accuracy, PR-AUC, Brier, reliability curve, false-positive cost in INR. The fitted weights are what the live detector runs. |
| **Chain Verifier** | `scripts/verify-audit-chain.ts` | CLI chain verification: exit 0 VALID / 1 TAMPERED. |
| **Smoke Test** | `scripts/smoke-test.ts` | Live HTTP contract check (see above). |

### Current Held-Out Fraud-Spike Results (dataset `held-out-test-v1`)

| Metric | Value |
|---|---|
| Decision threshold (tuned on DEV) | 0.275 — **now loaded by the live detector** |
| Evaluated windows / positives | 210 / 32 (15.24% prevalence) |
| Precision | 0.875 |
| Recall | 0.656 |
| F1 | 0.750 |
| False Positive Rate | 1.69% |
| Accuracy | 93.33% |
| PR-AUC / Brier | 0.873 / 0.0605 |
| False-positive cost | ₹174,311 (3 wrongly flagged legitimate windows) |
| **Value protected** | **₹51,77,000 — fraudulent value in the 21 true-positive windows (held-out test estimate; mirrored on the Overview page)** |
| Confusion matrix | TP 21 · FP 3 · FN 11 · TN 175 |
| Fitted calibration (live) | intercept −2.505, slope 1.045 |

**Why 0.656 recall, on purpose:** the 0.275 threshold was tuned on the dev split to bound false-positive *cost*, not to maximize recall. An auto-block on a false positive immediately costs a real sale; a missed spike still lands in `flag_for_review` and human review — the safety net behind the detector is the reason the threshold can lean conservative. The 11 false negatives are windows the system escalated rather than ignored.

Served at `GET /api/evaluation/fraud-spike`; the live detector's `calibration_source` field (and `/api/health`) shows `fitted` when the calibration file is loaded, `bootstrap_default` otherwise.

## Failure Recovery — and a true story about it

The pipeline never throws: a failed detector skips the LLM entirely (deterministic escalation), a failed LLM falls back to the mock provider and escalates, a failed executor probes downstream state, retries once, then escalates. Invalid data follows the same rule — the demo's `invalid_data` scenario sends an empty window with no trailing history, the real detector reports `insufficient_data` (it refuses to guess), the LLM is never called, and the event escalates to a human with the failure state on the audit record. All of it lands in the audit log.

The audit hash chain earned its keep during development, not on stage — twice. First: **the route-level contract tests once appended to the real demo audit log while the dev server was also writing to it.** Two concurrent writers interleaved records, and `GET /api/audit/verify` failed with `409 content hash mismatch — record was modified after writing` — the tamper detection caught real corruption that no human had noticed (the fix: tests run in an isolated temp `DATA_DIR`). Second: when the CLI verifier was later run against a *populated* file-backed chain, it exposed a genuine serialization bug — `stableStringify` emitted `"key":undefined` for optional fields, so every record's hash covered a string JSON could never reproduce after the file round-trip. Both verifications (`npm run verify-audit` and `GET /api/audit/verify`) now run against populated chains and pass, and regression tests pin the round-trip contract. That is the whole point of a hash-chained audit trail: tampering *and* implementation bugs are detectable — and here they demonstrably were.

## Frontend Pages

All 9 pages import types from `@risk-manager/shared` (no hand-copied type file exists anymore), send the API key on every call, and use the v2 response shapes (`detector` / `agent` / `policy` / `escalation`).

| Route | Page | Purpose |
|---|---|---|
| `/` | Overview | **Value protected (held-out estimate)** + FP cost headline, decision totals, evaluation metrics, pipeline diagram, recent decisions — served by `GET /api/dashboard` |
| `/fraud` | Fraud Monitor | Normal / spike / detector-failure simulations; **transaction-volume chart plotting the detector's real `baseline.trailing_counts` plus the current window** (recharts — no synthesized points); calibration source surfaced |
| `/return-risk` | Return Risk | Order simulation: probability meter, risk factors, action, policy |
| `/abuse-rings` | Abuse Rings | Cluster simulation: ring score, members, signals; **node-link graph of the actual union-find cluster** (accounts as circles, shared-attribute hubs as diamonds, edges colored by signal type — device/phone/email/address/payment/IP); "investigation, not conviction" notice |
| `/chargebacks` | Chargebacks | Dispute simulation: win probability, missing evidence, deadline |
| `/decisions` | AI Decisions | Decision cards from `GET /api/audit` |
| `/audit` | Audit Log | Server-side filterable audit table (module, confidence, escalation) |
| `/evaluation` | Evaluation | Live held-out metrics, confusion matrix, methodology |
| `/demo` | Demo Mode | One-click buttons for all 8 judge scenarios (5 modules + invalid data, detector failure, action timeout) + **Pay ₹100 Test** — a real Razorpay Test Mode checkout (see below) |

## Real ₹100 Razorpay Test Payment Flow

The Demo Mode page includes a real test-mode payment loop (nothing faked):

1. **Pay ₹100 Test** → `POST /api/razorpay/order` — the backend creates a real ₹100 (10000 paise) order via the Razorpay Orders API using `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` (server-side only; the key *secret* never reaches the browser — only the public key_id, per Razorpay's own checkout model).
2. The browser loads Razorpay's `checkout.js` and opens the **real Razorpay Test Checkout** modal.
3. On payment, the backend verifies the checkout `order_id|payment_id` HMAC with the key secret (`POST /api/webhooks/razorpay/verify-payment`).
4. Razorpay delivers the webhook to `POST /api/webhooks/razorpay` (via a public tunnel) → the backend verifies the HMAC-SHA256 over the **raw body** with `RAZORPAY_WEBHOOK_SECRET` → only then is the payment recorded as a **Transaction** (`backend/data/verified-transactions.json`). Duplicate deliveries dedupe; tampered signatures record nothing.
5. **Auto-activation**: a captured, signature-verified payment immediately runs the **real fraud-spike pipeline** over the merchant's actual verified-transaction window (last 10 minutes, with the merchant's own prior verified windows as the trailing baseline — current window excluded). The decision lands in the hash-chained audit log within seconds, visible on the Audit Log / Decisions pages. With a short verified-payment history the detector honestly reports `insufficient_data` and escalates to a human — never a fabricated score; real scoring engages as verified payments accumulate.

Integration tests pin the whole path (`routes/checkout.test.ts`): signed webhook → recorded payment + rupee-denominated transaction; duplicate → exactly one record; tampered → nothing; non-payment events → accepted but not recorded; captured payment → auto-triggered scan produces a `razorpay_scan_` audit record for the razorpay test merchant. Building this feature exposed and fixed two latent webhook bugs (raw-body capture never fired — path/encoding mismatch — and API-key auth would have rejected every real Razorpay webhook); both are regression-tested.

The built-in design system (`components/ui.tsx` + `icons.tsx`) is wired into all pages (StatCard, RiskMeter, ModuleBadge, ConfidenceBadge, Card/PageHeader, Button).

## Testing

**122 backend tests, 14 suites, all green:**

- All four detectors (95–100% coverage); every policy escalation check and its precedence; the one-directional escalation invariant; audit tamper detection; idempotency/replay/retry/double-failure escalation; agent guard adversarial cases (score drift, fabricated evidence, hallucinated `permanent_ban`, cross-module actions); webhook signature verification including the re-serialized-JSON rejection; end-to-end pipeline runs including fault injection.
- **15 route-level contract tests** (`routes/contract.test.ts`) pinning the exact P0 bug class: canonical routes, auth exemptions, all 8 scenarios returning bounded actions, and old-name rejection.
- **Driver-parity tests**: the Mongo hash-chain round-trip that the Docker Compose stack first exercised is now pinned offline — `stripUndefined` (Mongo serializes `undefined` as `null`; the hash function skips it) and `computeHash`'s storage-internal-key exclusion (`_id`) both have regression tests, so the file and Mongo drivers produce byte-identical chains.

Coverage concentrates on detectors, policy, execution, and the agent layer. Frontend: 7 Vitest tests in `api.test.ts` (API contract only — scenario URLs, auth header, audit filters); no component tests yet.

## Environment Configuration

Backend reads `.env` from `risk-manager/backend/` (see `backend/.env.example` — now accurate): `PORT`, `NODE_ENV`, `DB_DRIVER` (file|mongo), `MONGODB_URI`, `DATA_DIR`, `LLM_PROVIDER` (mock|gemini), `GEMINI_API_KEY`, `GEMINI_MODEL` (`gemini-2.0-flash` default), `LLM_TIMEOUT_MS`, `DETECTOR_TIMEOUT_MS`, `PAYMENT_PROVIDER` (mock|razorpay), `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `DEMO_API_KEY`, `REQUIRE_API_KEY`, `CORS_ORIGINS`, `LOG_LEVEL`. Frontend: `VITE_DEMO_API_KEY` (see `frontend/.env.example`).

Policy thresholds live in the versioned `backend/src/policy/policy.config.json` (not env vars), viewable live at `GET /api/policy/config`.

---

# 2. `risk_manager/` — Python Orchestration Package

A dependency-free (stdlib-only, Python 3.9+) package implementing the same bounded-action orchestration with pluggable deterministic risk tools. It exists to show the contract with zero dependencies; it is not the demo app.

## Files

| File | Contents |
|---|---|
| `__init__.py` | Exports `ACTION_SETS`, `MODULE_TO_TOOL`, `PolicyThresholds`, `RiskManagerOrchestrator`, `ToolNotRegisteredError` |
| `orchestrator.py` | `RiskManagerOrchestrator` (event routing, tool-result validation, decision formatting, escalation rules), frozen `PolicyThresholds`, per-module action allowlists, irreversible/human-review action sets, `REQUIRED_TOOL_FIELDS` schema |
| `demo_tools.py` | Deterministic implementations of the four risk tools + `demo_tools()` registry |

## How It Works

1. `RiskManagerOrchestrator(tools=..., policy=...)` takes a **tool name → callable** registry and optional thresholds.
2. `handle(event)` reads `event["module"]`, maps it to its tool, calls it, and validates the result against `REQUIRED_TOOL_FIELDS` — missing fields raise `ValueError`; **no risk opinion is generated**.
3. Scores convert to `confidence` (`high` at ≥0.80 or ≤0.20; `low` in the ambiguous 0.40–0.60 band; else `medium`), a bounded action is selected via the policy thresholds, and the escalation rule guarantees **irreversible actions never execute without a human**.
4. `handle_or_error(event)` returns an error dict instead of raising when a module has no registered tool.

```python
from risk_manager import RiskManagerOrchestrator, PolicyThresholds
from risk_manager.demo_tools import demo_tools

orchestrator = RiskManagerOrchestrator(tools=demo_tools(), policy=PolicyThresholds())
decision = orchestrator.handle({
    "module": "chargeback",
    "dispute_id": "disp_001",
    "reason_code": "fraudulent",
    "amount": 1500.0,
    "respond_by": "2026-09-10",
    "available_evidence": ["avs_match", "device_fingerprint", "delivery_confirmation"],
})
# p ≈ 0.57 — inside the ambiguous band → draft_for_human_review, escalate_to_human=True
```

Known caveat: with the bundled demo tools the maximum achievable win probability (~0.685) sits below the 0.70 partial-contest threshold, so demo chargebacks always resolve to `draft_for_human_review` or `recommend_accept_loss`. Register calibrated tools to reach the auto-contest actions.

> **Threshold provenance:** the Python package's chargeback thresholds (0.70 partial-contest / 0.85 full-contest / 0.20 accept-loss) are tuned **independently** from the TypeScript app's policy config (`backend/src/policy/policy.config.json` uses a single 0.90 `auto_action_threshold` for irreversible actions plus per-reason-code required evidence). The two implement the same bounded-action *contract* — identical action vocabularies, ambiguity band, and escalation invariants — but their numeric thresholds are separate tunings, not a shared constant. Do not read one as the source of the other's numbers.

---

# Known Issues & Limitations (current, verified)

**Backend (documented stubs — intentional demo scope):**
- The action executor's downstream call is a test-mode stub; it does not invoke the payment provider's `blockWindow`, and no outbound Razorpay REST calls exist anywhere. Payment-provider mode affects only signature verification and the mode banner.
- Verified webhooks are deduplicated and signature-checked but not yet routed into the risk pipeline.
- `RateLimiter` and idempotency are in-memory/JSON-file only (Redis swap documented, not implemented).
- `middleware/jwtAuthStub` is a deliberate no-op placeholder for production auth; the shipped auth is demo-grade single-key.
- Dead code remains: `features/transactions.ts`, `audit/logger.ts`, `audit/hashChain.ts` (superseded by `AuditService`), `fetchHealth` on the frontend, and a `void current;` no-op in `routes/fraudSpike.ts`.
- Detector/executor timeout races leave a pending `setTimeout` handle per call (minor; the hang-promises leak nothing by design).

**Frontend:**
- Vitest is configured with only the API-contract test file (`api.test.ts`, 7 tests); the pages themselves have no component tests.
- The Fraud Monitor chart plots the detector's real `baseline.trailing_counts` plus the current window — nothing is synthesized. If the merchant's history is shorter than 20 windows, fewer real points are plotted (no backfilling); with no history at all the chart shows an explicit empty state instead of invented data.

**General:**
- All data is synthetic; the audit log persists to JSON files or MongoDB (audit + idempotency only); transactions/orders are stateless per-request payloads.
- The LLM is a deterministic mock by default (`LLM_PROVIDER=mock`); with `gemini` configured, any LLM failure falls back to the mock and escalates.

# Planned Improvements

- Route verified webhooks into the risk pipeline beyond dedup
- Redis-backed rate limiting and idempotency
- Real Razorpay API integration behind the provider interface (replace the `blockWindow` stub)
- Production auth (replace the demo API key and JWT stub)
- Frontend component tests (the API contract is already covered by `api.test.ts`)
- Delete the remaining dead-code modules
- Python package: recalibrate `assess_chargeback` (or adjust thresholds) so auto-contest actions are reachable with the demo tools

# License

MIT
