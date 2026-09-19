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
