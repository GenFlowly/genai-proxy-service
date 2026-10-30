# Fly → Grafana Cloud Loki log shipper

Durable log storage for the org's Fly apps. Fly's own log buffer is
minutes-to-hours deep — the October 2026 retrieval-server OOM investigation
(`documents/Incidents/RetrievalServerMemoryLeakIncidentOct2026.md`) had weeks
of metrics but almost no log history. This app tails the org's NATS log
stream with [superfly/fly-log-shipper](https://github.com/superfly/fly-log-shipper)
(Vector) and forwards everything to Grafana Cloud Loki.

Cost: one shared-cpu-1x/256MB machine (~$2–3/mo). Log volume (prod logs
WARNING+ only) sits far inside Grafana Cloud's free tier (50 GB/mo ingest,
**14-day retention** — 30d needs a paid plan; 14d was judged enough, this
incident needed 4 days of history).

## Deploy (one-time, manual — needs org + Grafana Cloud credentials)

1. Grafana Cloud → your stack → Loki → "Details": note the push URL
   (`https://logs-prod-XXX.grafana.net`), the Loki username (numeric), and
   create an API token with `logs:write`.
2. Create the app and set secrets (never commit these):

   ```bash
   fly apps create genflowly-log-shipper --org genflowly
   fly secrets set -a genflowly-log-shipper \
     ORG=genflowly \
     ACCESS_TOKEN="$(fly tokens create readonly genflowly)" \
     LOKI_URL="https://logs-prod-XXX.grafana.net" \
     LOKI_USERNAME="<numeric user id>" \
     LOKI_PASSWORD="<logs:write API token>"
   fly deploy -c observability/log-shipper/fly.toml
   ```

3. Verify in Grafana Explore (Loki datasource):
   `{fly_app_name="genai-retrieval-server-production"}`.

## After logs flow: the OOM log alert

Add a Loki-based alert rule for the kernel OOM pattern — the one signal that
names the killed process directly:

```logql
count_over_time({fly_app_name=~".*-production"} |= "Out of memory: Killed process" [10m]) > 0
```

(Not in `observability/grafana/alerts/alerts-production.json` yet because the
rule needs the Loki datasource uid, which exists only after this shipper is
live — add it there with `__LOKI_DS_UID__` wiring once deployed.)
