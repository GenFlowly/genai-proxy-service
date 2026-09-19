#!/usr/bin/env python3
"""Regenerate the "Proxy Server APIs" dashboards from the proxy's routes.

Run this after adding/renaming an API in genai-proxy-server — every API gets a
pair of charts (requests by status, p50/p90/p95/p99 latency) side by side on
its own row, grouped into collapsed rows by subresource (/api/v1/agents/...,
/api/v1/conversation/..., ...). Writes proxy-apis-development.json and
proxy-apis-production.json and re-applies the global status color scheme.
See development.md "API metrics & dashboards".

Routes are discovered from the Routes object in Routing.kt plus route literals
in activity/ files, including path segments appended to a Routes const at the
call site (e.g. get("${Routes.X}/{version}")).

Usage: python3 generate_proxy_api_panels.py
"""
import json
import re
from pathlib import Path

import apply_color_scheme

HERE = Path(__file__).parent
SERVER_SRC = HERE.parent.parent / "genai-proxy-server" / "src" / "main" / "kotlin"

DS = {"type": "prometheus", "uid": "${DS_PROM}"}
QUANTILES = [("p50", 0.5), ("p90", 0.9), ("p95", 0.95), ("p99", 0.99)]

# Subresource grouping: first path segment after /api/v1, with aliases folding
# related segments into one group. Anything unlisted groups under its own segment.
GROUP_ALIASES = {
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


def discover_api_paths():
    consts = dict(
        re.findall(r'const val (\w+) = "\$API_V1(/[^"]*)"', (SERVER_SRC / "Routing.kt").read_text())
    )
    paths = []

    def add(path):
        full = "/api/v1" + path if not path.startswith("/api") else path
        if full not in paths:
            paths.append(full)

    for kt in sorted(SERVER_SRC.rglob("*.kt")):
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


def group_of(path):
    seg = path.split("/")[3]
    return GROUP_ALIASES.get(seg, seg)


def route_regex(path):
    # ends-with match tolerates selector prefixes in Ktor's route tag;
    # double-escaped braces survive PromQL string parsing as \{ \} for RE2
    return ".*" + path.replace("{", "\\\\{").replace("}", "\\\\}") + "$"


def base_panel(title, desc, x, y, w=12, h=8):
    return {
        "type": "timeseries", "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"custom": {"lineWidth": 2, "fillOpacity": 8, "showPoints": "never"}}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
        "targets": [], "description": desc,
    }


def api_panel_pair(env, path, y):
    # one API per row: status chart left, latency chart right
    app = f"genai-proxy-server-{env}"
    sel = f'app="{app}", route=~"{route_regex(path)}"'
    p_status = base_panel(path, f"Requests by status for {path} (cumulative counter; resets on deploy/restart).", 0, y)
    p_status["targets"] = [{
        "datasource": DS,
        "expr": f"sum by (status) (ktor_http_server_requests_seconds_count{{{sel}}})",
        "legendFormat": "{{status}}", "refId": "A",
    }]
    p_lat = base_panel(f"{path} — latency", f"Request latency percentiles for {path}.", 12, y)
    p_lat["fieldConfig"]["defaults"]["unit"] = "s"
    p_lat["targets"] = [{
        "datasource": DS,
        "expr": f"histogram_quantile({q}, sum by (le) (rate(ktor_http_server_requests_seconds_bucket{{{sel}}}[$__rate_interval])))",
        "legendFormat": name, "refId": chr(ord("A") + j),
    } for j, (name, q) in enumerate(QUANTILES)]
    return [p_status, p_lat]


def build_dashboard(env, paths):
    groups = {}
    for path in paths:
        groups.setdefault(group_of(path), []).append(path)

    panels, y = [], 0
    for group in sorted(groups):
        row = {"type": "row", "title": group.title(), "collapsed": True,
               "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []}
        inner_y = y + 1
        for path in sorted(groups[group]):
            row["panels"] += api_panel_pair(env, path, inner_y)
            inner_y += 8
        panels.append(row)
        y = inner_y

    return {
        "uid": f"proxy-apis-{env}",
        "title": f"Proxy Server APIs ({env.capitalize()})",
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


def remove_backend_row(env):
    """Drop the legacy 'Proxy Server' row from the Backend Services dashboard."""
    fname = HERE / f"fly-backend-{env}.json"
    d = json.loads(fname.read_text())
    idx = next((i for i, p in enumerate(d["panels"])
                if p["type"] == "row" and p["title"] == "Proxy Server"), None)
    if idx is None:
        return
    del d["panels"][idx]
    for p in d["panels"][idx:]:
        p["gridPos"]["y"] -= 1
    fname.write_text(json.dumps(d, indent=2) + "\n")
    print(f"{fname.name}: removed Proxy Server row")


def main():
    paths = discover_api_paths()
    print(f"{len(paths)} API paths discovered from proxy routes")
    for env in ("development", "production"):
        dash = build_dashboard(env, paths)
        fname = HERE / f"proxy-apis-{env}.json"
        fname.write_text(json.dumps(dash, indent=2) + "\n")
        n_groups = len(dash["panels"])
        n_panels = sum(len(r["panels"]) for r in dash["panels"])
        print(f"{fname.name}: {n_groups} groups, {n_panels} panels")
        remove_backend_row(env)
    apply_color_scheme.main()


if __name__ == "__main__":
    main()
