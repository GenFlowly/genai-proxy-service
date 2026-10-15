# Grafana dashboards

Dashboard JSONs for the Fly apps (Prometheus) and encoding lambdas (CloudWatch), one file per environment.

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

The script also owns two rows of the hand-made Backend Services dashboards (`fly-backend-*.json`), inserted right after the Service health charts (`BACKEND_ROWS`):

- **Agent runs** — durable `agent_run` outcomes by status, runs in flight (started minus finished), recoveries next to process restarts, dead letters by workflow, interrupted tool calls by tool, request agents by status.
- **PDF generation** — render time p50/p95 and status counts by renderer, child peak RSS, queue wait, warnings by kind, rejections by reason, render/spawn CPU and the PDF tools' executions (metrics registered in `retrieval-server/graph/pdf_metrics.py`).

Edit them in the script, not in the JSON: a regeneration replaces them.

## Alert rules (generated)

No alerting existed before; the script now writes Grafana-managed alert rules for the retrieval server's durable runs to `alerts/retrieval-alerts-{env}.json`, in the format of Grafana's alert-rule provisioning API (`/api/v1/provisioning/alert-rules`):

| Rule | Fires when | Severity |
|---|---|---|
| Retrieval server restarted | `process_start_time_seconds` changed in the last 10 min (deploy, crash or OOM kill) | warning |
| Retrieval server memory above 90% | for 2 min — the single machine is close to an OOM kill | warning |
| Durable agent run dead-lettered | any `durable_run_dead_lettered_total{workflow="agent_run"}` in 15 min (`request_agent_run` dead letters are only counted) | critical |
| More than 3 durable run recoveries in an hour | `increase(durable_run_recovered_total[1h]) > 3` | warning |
| Agent run error rate above 10% | errored `agent_run_total` share over 1 h, with at least 5 runs, for 10 min (a starting threshold: calibrate it) | warning |

They live in `alerts/`, not next to the dashboards: the dashboard workflows post every `*-{env}.json` at this level as a dashboard. The datasource uid is the placeholder `${DS_PROM_UID}`; deploy by substituting it and upserting each rule (folder `genflowly-{env}`, which the dashboard deploy creates):

```
jq -c --arg ds "$DS_PROM_UID" '.[] | (.data[] |= (if .datasourceUid == "${DS_PROM_UID}" then .datasourceUid = $ds else . end))' \
  alerts/retrieval-alerts-production.json | while read -r rule; do
  uid=$(jq -r .uid <<<"$rule")
  curl -sf -X PUT "$GRAFANA_URL/api/v1/provisioning/alert-rules/$uid" -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
    -H "Content-Type: application/json" -H "X-Disable-Provenance: true" -d "$rule" \
  || curl -sf -X POST "$GRAFANA_URL/api/v1/provisioning/alert-rules" -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
    -H "Content-Type: application/json" -H "X-Disable-Provenance: true" -d "$rule"
done
```

Notification routing (contact points, policies) is configured in Grafana; rules carry `service`, `severity` and `env` labels to route on.
