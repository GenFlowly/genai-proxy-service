#!/usr/bin/env python3
"""Stamp the global status color scheme (color-scheme.json) into every dashboard.

Grafana has no dashboard-level color definition that panels can inherit, so this
script is the "global" mechanism: the scheme is defined once in color-scheme.json
and injected as field overrides into every timeseries panel (series colored by
name: success=green, warning=yellow, error=red) and as thresholds into matching
stat panels. Idempotent — re-run after editing the scheme or the dashboards;
previously injected overrides (tagged __schemeRef) are replaced, hand-written
overrides are left alone.

Usage: python3 apply_color_scheme.py
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
SCHEME_REF = "status-color-scheme"


def series_overrides(scheme):
    return [
        {
            "__schemeRef": SCHEME_REF,
            "matcher": {"id": "byRegexp", "options": rule["regex"]},
            "properties": [
                {"id": "color", "value": {"mode": "fixed", "fixedColor": rule["color"]}}
            ],
        }
        for rule in scheme["series_rules"]
    ]


def apply_to_dashboard(dash, scheme):
    changed = 0
    for panel in dash.get("panels", []):
        panels = [panel] + panel.get("panels", [])  # include panels nested in rows
        for p in panels:
            fc = p.setdefault("fieldConfig", {"defaults": {}, "overrides": []})
            fc.setdefault("overrides", [])
            if p.get("type") == "timeseries":
                fc["overrides"] = [
                    o for o in fc["overrides"] if o.get("__schemeRef") != SCHEME_REF
                ] + series_overrides(scheme)
                changed += 1
            elif p.get("type") == "stat":
                for rule in scheme["stat_rules"]:
                    if re.search(rule["title_regex"], p.get("title", ""), re.I):
                        fc["defaults"].setdefault("color", {"mode": "thresholds"})
                        fc["defaults"]["thresholds"] = {
                            "mode": "absolute",
                            "steps": rule["steps"],
                        }
                        changed += 1
                        break
    return changed


def main():
    scheme = json.loads((HERE / "color-scheme.json").read_text())
    for path in sorted(HERE.glob("*.json")):
        if path.name == "color-scheme.json":
            continue
        dash = json.loads(path.read_text())
        n = apply_to_dashboard(dash, scheme)
        path.write_text(json.dumps(dash, indent=2) + "\n")
        print(f"{path.name}: scheme applied to {n} panels")


if __name__ == "__main__":
    main()
