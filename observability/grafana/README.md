# Grafana dashboards

Dashboard JSONs for the Fly apps (Prometheus) and encoding lambdas (CloudWatch), one file per environment.

## Datasources (as code)

The CloudWatch datasources the dashboards query are codified in `datasources/`:

- `lambdas-production.json` — **ProductionLambdas** (uid `bfxh1tvnrnu9sf`, assume-role into AWS account `189979486945`)
- `lambdas-development.json` — **DevelopmentLambdas** (uid `afxh14dyp3ldsd`, assume-role into `571600870493`)

The **same `*-grafana-dashboards.yml` workflow that deploys the dashboards** also upserts the matching datasource (prod deploys `datasources/*-production.json`, dev deploys `*-development.json`) **by uid** — PUT if present, POST to create — right before the dashboards. Upserting by uid is what matters: every dashboard pins its datasource by uid, so the uids must be preserved across any rebuild.

Writing datasources needs an **Admin** service-account token (dashboards/folders only need Editor), so the datasource step treats a **403 as a skip-with-warning** — a token-permission gap can never block the dashboard deploy. If you see that warning in the logs, upgrade the `GRAFANA_SA_TOKEN` service account to Admin so datasources deploy as code.

Both datasources authenticate via `grafana_assume_role` (Grafana Cloud's own AWS account assumes the read-only role in each target account), so **no secret lives in these files**. Dev additionally has legacy static AWS keys set in the live datasource; those are vestigial (auth is assume-role) and are intentionally not reproduced — on update Grafana keeps any secureJson fields the workflow doesn't send.

> Note: prod's `customMetricsNamespaces` is `"GenFlowly."` (trailing dot) vs dev's `"GenFlowly"`. This only seeds the namespace autocomplete in the query editor — it does not filter actual queries — so the files preserve live values as-is.

## Disaster recovery / cold-start rebuild

If the Grafana instance is ever deactivated/deleted (see **Keep-alive** below) and recreated, everything here is reproducible from code — dispatch both `prod-grafana-dashboards.yml` and `dev-grafana-dashboards.yml`. Each one recreates its CloudWatch datasource (with the pinned uid) and its folder, then upserts every dashboard — datasources first so the dashboards' refs resolve.

**The one non-codifiable step:** `grafana_assume_role` uses a Grafana-generated **external ID** that a recreated instance may re-issue. If the recreated datasources can't reach CloudWatch, open each datasource's settings, copy the shown AWS account + external ID, and update the trust policy on the `GrafanaCloudWatchReadOnly` IAM role in `189979486945` / `571600870493` to match. (The AWS Infra dashboard reads CloudWatch live, so there is no metric data to restore — only this trust relationship.)

## Keep-alive

Free-tier Grafana Cloud hibernates on inactivity (next visitor gets a 503 "Click to continue loading your instance") and, after prolonged inactivity, the org can be deactivated. `grafana-keepalive.yml` runs daily, waking the instance (retrying through the cold-start 503) and making one authenticated call so the visit registers as activity. Reuses the production environment's existing `GRAFANA_URL` / `GRAFANA_SA_TOKEN`; no new secrets.

## Global status color scheme

All charts follow one color convention, defined once in `color-scheme.json`:

- **green** — success (`ok`, 2xx / 200-class HTTP statuses, `succeeded`)
- **yellow** — warnings/degradations (retries, throttles, fallbacks, skips, `noop`, stale serves, zero-token streams, unpriced turns)
- **red** — errors (`error`, `failed`, 4xx and 5xx HTTP statuses, exhausted retries, timeouts, DLQ)

Series whose names match none of the rules (latency percentiles, token directions, model names, CPU) keep the default palette.

Grafana has no dashboard-level color definition panels can inherit, so the scheme is applied by a script:

```
python3 apply_color_scheme.py
```

It stamps the scheme's rules into every timeseries panel as `byRegexp` field overrides (tagged `__schemeRef`) and sets thresholds on the warning/failure stat panels. It is idempotent — after editing any dashboard or the scheme itself, just re-run it. Hand-written per-panel overrides are preserved.

**Do not hand-edit colors in the dashboard JSONs** — change `color-scheme.json` and re-apply.

## Per-API dashboards (generated)

The dedicated `proxy-apis-*.json` and `retrieval-apis-*.json` dashboards hold a chart pair (requests by status + latency percentiles) for every API of the proxy and retrieval servers, grouped into collapsed rows by subresource (Agents, Conversation, Instruction, ...). They are regenerated — not hand-edited — by:

```
python3 generate_api_dashboards.py
```

which discovers proxy routes from `Routing.kt`/`activity/` and retrieval routes from `routes/*.py` decorators, and re-applies the color scheme. Run it whenever an API is added or renamed. API route naming rules (ids in query params, not path segments) are in `genai-proxy-server/development.md` under "API metrics & dashboards".

The script also generates the `llm-metrics-*.json` dashboards (vendor/model usage pies, cost, and a row per vendor with per-model calls/latency/tokens). Vendors and models are never hardcoded — the vendor rows repeat over a `$vendor` Grafana variable and models are PromQL series, so new vendors/models appear automatically.

All generated dashboards follow a global layout rule of **2 charts per row** (`CHARTS_PER_ROW` in the script).
