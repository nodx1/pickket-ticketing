#!/usr/bin/env python3
"""Summarize and diff ZAP JSON reports across targets."""

from __future__ import annotations

import argparse
import glob
import json
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple

TARGETS = ("backend", "admin")
RISK_LABEL = {3: "High", 2: "Medium", 1: "Low", 0: "Info"}


@dataclass(frozen=True)
class Finding:
    target: str
    plugin_id: str
    alert: str
    riskcode: int


def _latest_report(report_dir: str, target: str) -> str | None:
    pattern = os.path.join(report_dir, f"{target}-*.json")
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def _to_int(value: object, fallback: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback


def load_report(report_file: str) -> Tuple[Dict[int, int], Dict[Finding, int]]:
    with open(report_file, encoding="utf-8") as f:
        data = json.load(f)

    severity_counts: Dict[int, int] = {3: 0, 2: 0, 1: 0, 0: 0}
    finding_counts: Dict[Finding, int] = {}

    for site in data.get("site", []):
        for alert in site.get("alerts", []):
            riskcode = _to_int(alert.get("riskcode"), 0)
            if riskcode not in severity_counts:
                riskcode = 0
            count = max(_to_int(alert.get("count"), 1), 1)
            severity_counts[riskcode] += count

            finding = Finding(
                target="",
                plugin_id=str(alert.get("pluginid", "")),
                alert=str(alert.get("alert", alert.get("name", "Unknown"))),
                riskcode=riskcode,
            )
            finding_counts[finding] = finding_counts.get(finding, 0) + count

    return severity_counts, finding_counts


def load_target_snapshots(report_dir: str) -> Dict[str, dict]:
    snapshots: Dict[str, dict] = {}
    for target in TARGETS:
        report_file = _latest_report(report_dir, target)
        if not report_file:
            continue

        severity_counts, finding_counts = load_report(report_file)
        scoped_findings: Dict[Finding, int] = {}
        for finding, count in finding_counts.items():
            scoped = Finding(
                target=target,
                plugin_id=finding.plugin_id,
                alert=finding.alert,
                riskcode=finding.riskcode,
            )
            scoped_findings[scoped] = count

        snapshots[target] = {
            "file": report_file,
            "severity": severity_counts,
            "findings": scoped_findings,
        }
    return snapshots


def aggregate_findings(snapshots: Dict[str, dict]) -> Dict[Finding, int]:
    merged: Dict[Finding, int] = {}
    for snapshot in snapshots.values():
        for finding, count in snapshot["findings"].items():
            merged[finding] = merged.get(finding, 0) + count
    return merged


def _finding_to_dict(finding: Finding, delta: int) -> dict:
    return {
        "target": finding.target,
        "plugin_id": finding.plugin_id,
        "alert": finding.alert,
        "riskcode": finding.riskcode,
        "risk": RISK_LABEL.get(finding.riskcode, "Info"),
        "delta": delta,
    }


def build_diff(current: Dict[Finding, int], previous: Dict[Finding, int]) -> dict:
    increases: List[dict] = []
    decreases: List[dict] = []
    for finding in sorted(set(current) | set(previous), key=lambda f: (f.target, -f.riskcode, f.plugin_id, f.alert)):
        curr = current.get(finding, 0)
        prev = previous.get(finding, 0)
        delta = curr - prev
        if delta > 0:
            increases.append(_finding_to_dict(finding, delta))
        elif delta < 0:
            decreases.append(_finding_to_dict(finding, delta))

    has_regression = any(item["riskcode"] >= 2 for item in increases)
    return {
        "has_regression": has_regression,
        "new_or_increased": increases,
        "resolved_or_decreased": decreases,
    }


def severity_rollup(snapshots: Dict[str, dict]) -> dict:
    rollup = {label: 0 for label in RISK_LABEL.values()}
    per_target = {}
    for target, snapshot in snapshots.items():
        counts = snapshot["severity"]
        mapped = {RISK_LABEL[k]: counts.get(k, 0) for k in sorted(RISK_LABEL, reverse=True)}
        per_target[target] = mapped
        for key, value in mapped.items():
            rollup[key] += value
    return {"totals": rollup, "per_target": per_target}


def markdown_report(current_summary: dict, previous_available: bool, diff: dict) -> str:
    lines: List[str] = []
    lines.append("# Nightly DAST Diff Report")
    lines.append("")
    lines.append(f"- regression: {'YES' if diff['has_regression'] else 'NO'}")
    lines.append(f"- previous_run_available: {'YES' if previous_available else 'NO'}")
    lines.append("")
    lines.append("## Current Severity Totals")
    lines.append("")
    lines.append("| High | Medium | Low | Info |")
    lines.append("| ---: | ---: | ---: | ---: |")
    totals = current_summary["severity"]["totals"]
    lines.append(f"| {totals['High']} | {totals['Medium']} | {totals['Low']} | {totals['Info']} |")
    lines.append("")
    lines.append("## Current Per Target")
    lines.append("")
    lines.append("| Target | High | Medium | Low | Info |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for target in TARGETS:
        row = current_summary["severity"]["per_target"].get(target, {"High": 0, "Medium": 0, "Low": 0, "Info": 0})
        lines.append(f"| {target} | {row['High']} | {row['Medium']} | {row['Low']} | {row['Info']} |")

    def _append_table(title: str, entries: List[dict]) -> None:
        lines.append("")
        lines.append(f"## {title}")
        lines.append("")
        if not entries:
            lines.append("- none")
            return
        lines.append("| Target | Risk | Rule | Alert | Delta |")
        lines.append("| --- | --- | ---: | --- | ---: |")
        for item in entries:
            lines.append(
                f"| {item['target']} | {item['risk']} | {item['plugin_id']} | {item['alert']} | {item['delta']} |"
            )

    _append_table("New or Increased Findings", diff["new_or_increased"])
    _append_table("Resolved or Decreased Findings", diff["resolved_or_decreased"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Diff DAST report outputs")
    parser.add_argument("--current-dir", required=True)
    parser.add_argument("--previous-dir")
    parser.add_argument("--out-json", required=True)
    parser.add_argument("--out-md", required=True)
    parser.add_argument("--fail-on-regression", action="store_true")
    args = parser.parse_args()

    current_snapshots = load_target_snapshots(args.current_dir)
    if not current_snapshots:
        raise SystemExit("No current DAST reports found")

    previous_snapshots = load_target_snapshots(args.previous_dir) if args.previous_dir else {}
    previous_available = bool(previous_snapshots)

    current_findings = aggregate_findings(current_snapshots)
    previous_findings = aggregate_findings(previous_snapshots)
    diff = build_diff(current_findings, previous_findings)

    output = {
        "current": {
            "reports": {k: v["file"] for k, v in current_snapshots.items()},
            "severity": severity_rollup(current_snapshots),
        },
        "previous": {
            "available": previous_available,
            "reports": {k: v["file"] for k, v in previous_snapshots.items()},
            "severity": severity_rollup(previous_snapshots) if previous_available else None,
        },
        "diff": diff,
    }

    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    md = markdown_report(output["current"], previous_available, diff)
    with open(args.out_md, "w", encoding="utf-8") as f:
        f.write(md)

    print(md)
    if args.fail_on_regression and diff["has_regression"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
