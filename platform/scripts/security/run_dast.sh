#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Runtime DAST runner (OWASP ZAP baseline via Docker)
# ---------------------------------------------------------------------------
# Defaults:
#   backend -> http://127.0.0.1:8001/health
#   admin   -> http://127.0.0.1:3022
#
# Optional envs:
#   DAST_REPORT_DIR
#   DAST_MINUTES
#   DAST_FAIL_ON_MEDIUM
#   DAST_IGNORE_RULE_IDS
#   DAST_BACKEND_URL / DAST_ADMIN_URL
#     - empty string("")로 지정하면 해당 타겟 스캔을 비활성화
# ---------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required for DAST scan." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT_DIR="${DAST_REPORT_DIR:-$ROOT_DIR/security-reports}"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [[ "${CI:-false}" == "true" ]]; then
  # CI profile: stricter by default (medium findings fail, no ignored rules).
  MINUTES="${DAST_MINUTES:-2}"
  FAIL_ON_MEDIUM="${DAST_FAIL_ON_MEDIUM:-true}"
  IGNORE_RULE_IDS="${DAST_IGNORE_RULE_IDS:-}"
else
  # Local profile: practical defaults to reduce noise during developer runs.
  MINUTES="${DAST_MINUTES:-2}"
  FAIL_ON_MEDIUM="${DAST_FAIL_ON_MEDIUM:-false}"
  IGNORE_RULE_IDS="${DAST_IGNORE_RULE_IDS:-10049}"
fi

mkdir -p "$REPORT_DIR"

BACKEND_URL="${DAST_BACKEND_URL-http://127.0.0.1:8001/health}"
ADMIN_URL="${DAST_ADMIN_URL-http://127.0.0.1:3022}"

declare -a TARGETS=()
[[ -n "$BACKEND_URL" ]] && TARGETS+=("backend|${BACKEND_URL}")
[[ -n "$ADMIN_URL" ]] && TARGETS+=("admin|${ADMIN_URL}")

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "[ERROR] no DAST targets configured." >&2
  exit 1
fi

final_status=0

for item in "${TARGETS[@]}"; do
  name="${item%%|*}"
  url="${item#*|}"
  base="${name}-${STAMP}"

  echo "[INFO] Running ZAP baseline for ${name}: ${url}"
  docker run --rm --user root --network host \
    -v "$REPORT_DIR:/zap/wrk" \
    ghcr.io/zaproxy/zaproxy:stable \
    zap-baseline.py \
      -t "$url" \
      -m "$MINUTES" \
      -J "${base}.json" \
      -w "${base}.md" \
      -r "${base}.html" || true

  json_file="${REPORT_DIR}/${base}.json"
  if [[ ! -f "$json_file" ]]; then
    echo "[ERROR] Missing DAST report: ${json_file}" >&2
    final_status=1
    continue
  fi

  read -r high medium low info < <(
    python3 - "$json_file" "$IGNORE_RULE_IDS" <<'PY'
import json
import sys

report_path = sys.argv[1]
ignore_ids = {item.strip() for item in sys.argv[2].split(",") if item.strip()}

with open(report_path, encoding="utf-8") as f:
    data = json.load(f)

counts = {0: 0, 1: 0, 2: 0, 3: 0}
for site in data.get("site", []):
    for alert in site.get("alerts", []):
        if str(alert.get("pluginid", "")) in ignore_ids:
            continue
        try:
            risk = int(alert.get("riskcode", 0))
        except (TypeError, ValueError):
            risk = 0
        try:
            count = int(alert.get("count", 1))
        except (TypeError, ValueError):
            count = 1
        if risk not in counts:
            risk = 0
        counts[risk] += max(count, 1)

print(counts[3], counts[2], counts[1], counts[0])
PY
  )

  echo "[RESULT] ${name}: High=${high} Medium=${medium} Low=${low} Info=${info} (ignored: ${IGNORE_RULE_IDS:-none})"

  if [[ "${high}" != "0" ]]; then
    echo "[ERROR] ${name}: High findings detected." >&2
    final_status=1
  fi

  if [[ "${FAIL_ON_MEDIUM}" == "true" && "${medium}" != "0" ]]; then
    echo "[ERROR] ${name}: Medium findings detected and DAST_FAIL_ON_MEDIUM=true." >&2
    final_status=1
  fi
done

if [[ "$final_status" -ne 0 ]]; then
  echo "[FAIL] DAST gate failed. See ${REPORT_DIR}/*.json and *.md for details." >&2
  exit "$final_status"
fi

echo "[OK] DAST gate passed (no High findings)."
