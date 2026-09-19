#!/usr/bin/env python3
"""Regenerate the "Proxy Server" per-API dashboard section from the proxy's routes.

Run this after adding/renaming an API in genai-proxy-server — every API gets a
pair of charts (requests by status, p50/p90/p95/p99 latency) in the collapsed
"Proxy Server" row of both fly-backend dashboards, colored by the global status
color scheme. See development.md "API metrics & dashboards".

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


def api_panels(env, paths, row_y):
    app = f"genai-proxy-server-{env}"
    out = []
    for i, path in enumerate(paths):
        # one API per row: status chart left, latency chart right
        y = row_y + 1 + i * 8
        x = 0
        sel = f'app="{app}", route=~"{route_regex(path)}"'
        p_status = base_panel(path, f"Requests by status for {path} (cumulative counter; resets on deploy/restart).", x, y)
        p_status["targets"] = [{
            "datasource": DS,
            "expr": f"sum by (status) (ktor_http_server_requests_seconds_count{{{sel}}})",
            "legendFormat": "{{status}}", "refId": "A",
        }]
        p_lat = base_panel(f"{path} — latency", f"Request latency percentiles for {path}.", x + 12, y)
        p_lat["fieldConfig"]["defaults"]["unit"] = "s"
        p_lat["targets"] = [{
            "datasource": DS,
            "expr": f"histogram_quantile({q}, sum by (le) (rate(ktor_http_server_requests_seconds_bucket{{{sel}}}[$__rate_interval])))",
            "legendFormat": name, "refId": chr(ord("A") + j),
        } for j, (name, q) in enumerate(QUANTILES)]
        out += [p_status, p_lat]
    return out


def main():
    paths = discover_api_paths()
    print(f"{len(paths)} API paths discovered from proxy routes")
    for env in ("development", "production"):
        fname = HERE / f"fly-backend-{env}.json"
        d = json.loads(fname.read_text())
        row = next(
            (p for p in d["panels"] if p["type"] == "row" and p["title"] == "Proxy Server"),
            None,
        )
        if row is None:
            raise SystemExit(f'{fname.name}: no "Proxy Server" row found — add one before generating')
        row["collapsed"] = True
        row["panels"] = api_panels(env, paths, row["gridPos"]["y"])
        fname.write_text(json.dumps(d, indent=2) + "\n")
        print(f"{fname.name}: Proxy Server row rebuilt with {len(row['panels'])} panels")
    apply_color_scheme.main()


if __name__ == "__main__":
    main()
