#!/usr/bin/env python3
"""Regenerate the per-API dashboards for the proxy and retrieval servers.

Run this after adding/renaming an API in genai-proxy-server or
retrieval-server — every API gets a pair of charts (requests by status,
p50/p90/p95/p99 latency) side by side on its own row, grouped into collapsed
rows by subresource. Writes proxy-apis-{env}.json and retrieval-apis-{env}.json
and re-applies the global status color scheme.
See genai-proxy-server/development.md "API metrics & dashboards".

Routes are discovered from source:
- proxy: the Routes object in Routing.kt plus route literals in activity/
  files, including path segments appended to a Routes const at the call site
- retrieval: @router.<method>("...") decorators in routes/*.py (websocket
  routes excluded — the HTTP instrumentator middleware doesn't record them)

Usage: python3 generate_api_dashboards.py
"""
import json
import re
from pathlib import Path

import apply_color_scheme

HERE = Path(__file__).parent
REPO = HERE.parent.parent

DS = {"type": "prometheus", "uid": "${DS_PROM}"}
QUANTILES = [("p50", 0.5), ("p90", 0.9), ("p95", 0.95), ("p99", 0.99)]

# Global layout rule: 2 charts per row on every generated dashboard.
CHARTS_PER_ROW = 2
PANEL_W = 24 // CHARTS_PER_ROW
PANEL_H = 8

# Subresource grouping: first path segment (after /api/v1 for the proxy), with
# aliases folding related segments into one group. Unlisted segments group
# under their own name.
PROXY_GROUP_ALIASES = {
    "chat": "conversation",
    "conversations": "conversation",
    "instructions": "instruction",
    "generate-text": "generation",
    "generate-text-stream": "generation",
    "generations": "generation",
    "message": "generation",
    "request-agents": "agents",
    "node-presets": "agents",
    "store-api-key": "keys & config",
    "store-vendor-config": "keys & config",
    "store-embedding-key": "keys & config",
    "store-vector-db-config": "keys & config",
    "save-ai-config": "keys & config",
    "embedding-keys": "keys & config",
    "embedding-models": "keys & config",
    "models": "models & providers",
    "providers": "models & providers",
    "onboard": "customer & profile",
    "profile": "customer & profile",
    "users": "customer & profile",
    "developer": "developer keys",
}
RETRIEVAL_GROUP_ALIASES = {
    "retrieve": "generation & graphs",
    "execute-agent-graph": "generation & graphs",
    "models": "models & providers",
    "providers": "models & providers",
    "validate-key": "models & providers",
    "delete-note-vectors": "vector deletes",
    "delete-memory-vectors": "vector deletes",
    "delete-instruction-vectors": "vector deletes",
}


def discover_proxy_paths():
    src_root = REPO / "genai-proxy-server" / "src" / "main" / "kotlin"
    consts = dict(
        re.findall(r'const val (\w+) = "\$API_V1(/[^"]*)"', (src_root / "Routing.kt").read_text())
    )
    paths = []

    def add(path):
        full = "/api/v1" + path if not path.startswith("/api") else path
        if full not in paths:
            paths.append(full)

    for kt in sorted(src_root.rglob("*.kt")):
        if kt.name == "Routing.kt":
            continue
        src = kt.read_text()
        # Routes.CONST used directly or with appended segments
        for name, suffix in re.findall(r'Routes\.([A-Z_]+)\}?([/\w{}-]*)"?', src):
            if name in consts:
                add(consts[name] + suffix.rstrip('"'))
        # inline literals (e.g. the notes routes)
        for path in re.findall(r'"(/api/v1/[^"$ ]*)"', src):
            add(path)
    return paths


def discover_retrieval_paths():
    paths = []
    for py in sorted((REPO / "retrieval-server" / "routes").glob("*.py")):
        for method, path in re.findall(
            r'@router\.(get|post|put|delete)\(\s*["\']([^"\']+)', py.read_text()
        ):
            if path not in paths:
                paths.append(path)
    return paths


def proxy_selector(env, path):
    # ends-with regex tolerates selector prefixes in Ktor's route tag;
    # double-escaped braces survive PromQL string parsing as \{ \} for RE2
    regex = ".*" + path.replace("{", "\\\\{").replace("}", "\\\\}") + "$"
    return f'app="genai-proxy-server-{env}", route=~"{regex}"'


def retrieval_selector(env, path):
    return f'app="genai-retrieval-server-{env}", handler="{path}"'


SERVICES = {
    "proxy": {
        "title": "Proxy Server APIs",
        "discover": discover_proxy_paths,
        "selector": proxy_selector,
        "group_segment_index": 3,  # /api/v1/<segment>
        "group_aliases": PROXY_GROUP_ALIASES,
        "count_metric": "ktor_http_server_requests_seconds_count",
        "bucket_metric": "ktor_http_server_requests_seconds_bucket",
        "legacy_backend_row": "Proxy Server",
    },
    "retrieval": {
        "title": "Retrieval Server APIs",
        "discover": discover_retrieval_paths,
        "selector": retrieval_selector,
        "group_segment_index": 1,  # /<segment>
        "group_aliases": RETRIEVAL_GROUP_ALIASES,
        "count_metric": "http_requests_total",
        "bucket_metric": "http_request_duration_seconds_bucket",
        "legacy_backend_row": "Internal requests/h (proxy -> backends)",
    },
}


def base_panel(title, desc, x, y, w=PANEL_W, h=PANEL_H, points=False):
    # points=True: per-interval counter values — dots connected by a line
    # (never graph a raw cumulative counter — it just adds up forever)
    custom = ({"drawStyle": "line", "lineWidth": 1, "pointSize": 5, "showPoints": "always"}
              if points else {"lineWidth": 2, "fillOpacity": 8, "showPoints": "never"})
    return {
        "type": "timeseries", "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"custom": custom}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
        "targets": [], "description": desc,
    }


def api_panel_pair(svc, env, path, y):
    # one API per row: status chart left, latency chart right
    sel = svc["selector"](env, path)
    p_status = base_panel(path, f"Requests per interval for {path}, by status.", 0, y, points=True)
    assert CHARTS_PER_ROW == 2, "api dashboards lay out status+latency pairs"
    p_status["targets"] = [{
        "datasource": DS,
        "expr": f"sum by (status) (increase({svc['count_metric']}{{{sel}}}[$__rate_interval]))",
        "legendFormat": "{{status}}", "refId": "A",
    }]
    p_lat = base_panel(f"{path} — latency", f"Request latency percentiles for {path}.", PANEL_W, y)
    p_lat["fieldConfig"]["defaults"]["unit"] = "s"
    p_lat["targets"] = [{
        "datasource": DS,
        "expr": f"histogram_quantile({q}, sum by (le) (rate({svc['bucket_metric']}{{{sel}}}[$__rate_interval])))",
        "legendFormat": name, "refId": chr(ord("A") + j),
    } for j, (name, q) in enumerate(QUANTILES)]
    return [p_status, p_lat]


def build_dashboard(svc_key, svc, env, paths):
    groups = {}
    for path in paths:
        seg = path.split("/")[svc["group_segment_index"]]
        groups.setdefault(svc["group_aliases"].get(seg, seg), []).append(path)

    panels, y = [], 0
    for group in sorted(groups):
        row = {"type": "row", "title": group.title(), "collapsed": True,
               "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []}
        inner_y = y + 1
        for path in sorted(groups[group]):
            row["panels"] += api_panel_pair(svc, env, path, inner_y)
            inner_y += PANEL_H
        panels.append(row)
        y = inner_y

    return {
        "uid": f"{svc_key}-apis-{env}",
        "title": f"{svc['title']} ({env.capitalize()})",
        "tags": ["genflowly", "observability", env],
        "timezone": "browser",
        "schemaVersion": 39,
        "refresh": "1m",
        "time": {"from": "now-6h", "to": "now"},
        "templating": {"list": [{
            "name": "DS_PROM",
            "label": "Prometheus datasource",
            "type": "datasource",
            "query": "prometheus",
            "current": {},
            "hide": 0,
        }]},
        "panels": panels,
    }


def pie_panel(title, desc, expr, legend, x, y):
    return {
        "type": "piechart", "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": PANEL_W, "h": PANEL_H},
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {
            "pieType": "pie",
            "reduceOptions": {"calcs": ["lastNotNull"], "values": False},
            "legend": {"displayMode": "table", "placement": "right", "values": ["value", "percent"]},
            "tooltip": {"mode": "single"},
        },
        "targets": [{"datasource": DS, "expr": expr, "legendFormat": legend, "instant": True, "refId": "A"}],
        "description": desc,
    }


def ts_panel(title, desc, targets, x, y, unit=None, points=False):
    p = base_panel(title, desc, x, y, points=points)
    if unit:
        p["fieldConfig"]["defaults"]["unit"] = unit
    p["targets"] = [dict(t, datasource=DS, refId=chr(ord("A") + i)) for i, t in enumerate(targets)]
    return p


def stat_panel(title, desc, expr, legend, x, y, unit=None):
    p = {
        "type": "stat", "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": PANEL_W, "h": PANEL_H},
        "fieldConfig": {"defaults": {"decimals": 2}, "overrides": []},
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "values": False},
            "textMode": "value_and_name",
            "colorMode": "value",
        },
        "targets": [{"datasource": DS, "expr": expr, "legendFormat": legend, "instant": True, "refId": "A"}],
        "description": desc,
    }
    if unit:
        p["fieldConfig"]["defaults"]["unit"] = unit
    return p


def build_llm_dashboard(env):
    """LLM Metrics dashboard. Vendors and models are runtime data (the model
    catalog is dynamic), so nothing is enumerated here: per-vendor grouping
    comes from a Grafana row repeated over the $vendor variable, and models
    appear as series via sum by (model). New vendors/models show up on the
    dashboard automatically."""
    app = f'app=~".*-{env}"'
    v = f'{app}, vendor=~"$vendor", model=~"$model"'

    overview = {"type": "row", "title": "Overview", "collapsed": False,
                "gridPos": {"x": 0, "y": 0, "w": 24, "h": 1}}
    pies = [
        pie_panel("Vendor usage distribution",
                  "Share of LLM calls per vendor over the dashboard time range.",
                  f'sum by (vendor) (increase(llm_request_total{{{app}}}[$__range]))',
                  "{{vendor}}", 0, 1),
        pie_panel("Vendor-model usage distribution",
                  "Share of LLM calls per vendor and model over the dashboard time range.",
                  f'sum by (vendor, model) (increase(llm_request_total{{{app}}}[$__range]))',
                  "{{vendor}} {{model}}", PANEL_W, 1),
    ]

    cost_row = {"type": "row", "title": "Cost", "collapsed": False,
                "gridPos": {"x": 0, "y": 9, "w": 24, "h": 1}}
    cost_panels = [
        stat_panel("Total cost per vendor (USD)",
                   "Total LLM spend per vendor over the dashboard time range.",
                   f'sum by (vendor) (increase(llm_cost_usd_total{{{app}}}[$__range]))',
                   "{{vendor}}", 0, 10, unit="currencyUSD"),
        stat_panel("Total cost per vendor-model (USD)",
                   "Total LLM spend per vendor and model over the dashboard time range.",
                   f'sum by (vendor, model) (increase(llm_cost_usd_total{{{app}}}[$__range]))',
                   "{{vendor}} {{model}}", PANEL_W, 10, unit="currencyUSD"),
    ]

    # Row repeated per vendor; inside, every metric panel repeats per model so
    # each vendor-model combination gets its own chart — no overlapping series,
    # fully dynamic via the chained $vendor/$model variables.
    vendor_row = {"type": "row", "title": "Vendor: $vendor", "collapsed": True,
                  "repeat": "vendor", "gridPos": {"x": 0, "y": 18, "w": 24, "h": 1},
                  "panels": []}
    vy = 19
    vendor_charts = [
        ("Calls — $model",
         "LLM calls per interval.",
         [{"expr": f'sum by (model) (increase(llm_request_total{{{v}}}[$__rate_interval]))', "legendFormat": "{{model}}"}], None, True),
        ("Response latency p95 — $model",
         "p95 time to get a response from the vendor.",
         [{"expr": f'histogram_quantile(0.95, sum by (le, model) (rate(llm_request_duration_seconds_bucket{{{v}}}[$__rate_interval])))',
           "legendFormat": "{{model}}"}], "s", False),
        ("Generation time — $model",
         "Seconds spent generating per interval.",
         [{"expr": f'sum by (model) (increase(llm_request_duration_seconds_sum{{{v}}}[$__rate_interval]))', "legendFormat": "{{model}}"}], "s", True),
        ("Input tokens — $model",
         "Input tokens per interval.",
         [{"expr": f'sum by (model) (increase(llm_tokens_total{{{v}, direction="input"}}[$__rate_interval]))', "legendFormat": "{{model}}"}], None, True),
        ("Output tokens — $model",
         "Output tokens per interval.",
         [{"expr": f'sum by (model) (increase(llm_tokens_total{{{v}, direction="output"}}[$__rate_interval]))', "legendFormat": "{{model}}"}], None, True),
        ("Cache tokens — $model",
         "Cache tokens (read + creation) per interval.",
         [{"expr": f'sum by (model) (increase(llm_tokens_total{{{v}, direction=~"cache_read|cache_creation"}}[$__rate_interval]))',
           "legendFormat": "{{model}}"}], None, True),
    ]
    for i, (title, desc, targets, unit, points) in enumerate(vendor_charts):
        p = ts_panel(title, desc, targets, 0, vy + i * PANEL_H, unit=unit, points=points)
        p["repeat"] = "model"
        p["repeatDirection"] = "h"
        p["maxPerRow"] = CHARTS_PER_ROW
        vendor_row["panels"].append(p)

    return {
        "uid": f"llm-metrics-{env}",
        "title": f"LLM Metrics ({env.capitalize()})",
        "tags": ["genflowly", "observability", env],
        "timezone": "browser",
        "schemaVersion": 39,
        "refresh": "1m",
        "time": {"from": "now-6h", "to": "now"},
        "templating": {"list": [
            {
                "name": "DS_PROM",
                "label": "Prometheus datasource",
                "type": "datasource",
                "query": "prometheus",
                "current": {},
                "hide": 0,
            },
            {
                "name": "vendor",
                "label": "Vendor",
                "type": "query",
                "datasource": DS,
                "query": {
                    "query": f'label_values(llm_request_total{{app=~".*-{env}"}}, vendor)',
                    "refId": "PrometheusVariableQueryEditor-VariableQuery",
                },
                "refresh": 2,
                "includeAll": True,
                "multi": True,
                "sort": 1,
                "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
            },
            {
                "name": "model",
                "label": "Model",
                "type": "query",
                "datasource": DS,
                "query": {
                    "query": f'label_values(llm_request_total{{app=~".*-{env}", vendor=~"$vendor"}}, model)',
                    "refId": "PrometheusVariableQueryEditor-VariableQuery",
                },
                "refresh": 2,
                "includeAll": True,
                "multi": True,
                "sort": 1,
                "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
            },
        ]},
        "panels": [overview, *pies, cost_row, *cost_panels, vendor_row],
    }


def remove_backend_row(env, title):
    """Drop a legacy row (and its sibling panels up to the next row) from the
    Backend Services dashboard."""
    fname = HERE / f"fly-backend-{env}.json"
    d = json.loads(fname.read_text())
    panels = d["panels"]
    idx = next((i for i, p in enumerate(panels)
                if p["type"] == "row" and p["title"] == title), None)
    if idx is None:
        return
    end = next((i for i in range(idx + 1, len(panels)) if panels[i]["type"] == "row"), len(panels))
    shift = (panels[end]["gridPos"]["y"] if end < len(panels) else panels[-1]["gridPos"]["y"] + panels[-1]["gridPos"]["h"]) - panels[idx]["gridPos"]["y"]
    del panels[idx:end]
    for p in panels[idx:]:
        p["gridPos"]["y"] -= shift
    fname.write_text(json.dumps(d, indent=2) + "\n")
    print(f"{fname.name}: removed '{title}' row")


def main():
    for svc_key, svc in SERVICES.items():
        paths = svc["discover"]()
        print(f"{svc_key}: {len(paths)} API paths discovered")
        for env in ("development", "production"):
            dash = build_dashboard(svc_key, svc, env, paths)
            fname = HERE / f"{svc_key}-apis-{env}.json"
            fname.write_text(json.dumps(dash, indent=2) + "\n")
            n_panels = sum(len(r["panels"]) for r in dash["panels"])
            print(f"{fname.name}: {len(dash['panels'])} groups, {n_panels} panels")
            remove_backend_row(env, svc["legacy_backend_row"])
    for env in ("development", "production"):
        dash = build_llm_dashboard(env)
        fname = HERE / f"llm-metrics-{env}.json"
        fname.write_text(json.dumps(dash, indent=2) + "\n")
        print(f"{fname.name}: written")
        remove_backend_row(env, "LLM")
        remove_backend_row(env, "Model: $model")
        # drop the vendor/model variables the removed LLM rows used
        fly = HERE / f"fly-backend-{env}.json"
        d = json.loads(fly.read_text())
        tvars = d.get("templating", {}).get("list", [])
        kept = [t for t in tvars if t["name"] not in ("vendor", "model")]
        if len(kept) != len(tvars):
            d["templating"]["list"] = kept
            fly.write_text(json.dumps(d, indent=2) + "\n")
            print(f"{fly.name}: removed unused vendor/model variables")
    apply_color_scheme.main()


if __name__ == "__main__":
    main()
