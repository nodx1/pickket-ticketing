#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Unified security gate:
# 1) JS dependency audit (pnpm)
# 2) Python dependency audit (pip-audit for backend + engine)
# 3) Secret scan (gitleaks via Docker)
# 4) SBOM generation (syft via Docker)
# 5) Filesystem vuln scan (trivy via Docker, CRITICAL gate)
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT_DIR="${SECURITY_REPORT_DIR:-$ROOT_DIR/security-reports}"
SBOM_DIR="${REPORT_DIR}/sbom"
SCANS_DIR="${REPORT_DIR}/scans"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$SBOM_DIR" "$SCANS_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 is required." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[ERROR] pnpm is required." >&2
  exit 1
fi

echo "[1/5] Running pnpm audit (high+)..."
(
  cd "$ROOT_DIR"
  pnpm audit --prod --audit-level=high
)

echo "[2/5] Running pip-audit (backend + engine)..."
tmp_backend="$(mktemp -d)"
python3 -m venv "${tmp_backend}/venv"
source "${tmp_backend}/venv/bin/activate"
pip install --upgrade pip >/dev/null
pip install -r "${ROOT_DIR}/backend/requirements.lock" pip-audit >/dev/null
pip-audit --strict --progress-spinner off
deactivate
rm -rf "$tmp_backend"

tmp_engine="$(mktemp -d)"
python3 -m venv "${tmp_engine}/venv"
source "${tmp_engine}/venv/bin/activate"
pip install --upgrade pip >/dev/null
pip install -r "${ROOT_DIR}/engine/requirements.lock" pip-audit >/dev/null
pip-audit --strict --progress-spinner off
deactivate
rm -rf "$tmp_engine"

echo "[3/5] Running gitleaks secret scan..."
docker run --rm \
  -v "$ROOT_DIR:/repo" \
  zricethezav/gitleaks:v8.18.4 detect \
    --source=/repo \
    --config=/repo/.gitleaks.toml \
    --redact \
    --report-format=json \
    --report-path="/repo/security-reports/scans/gitleaks-${STAMP}.json"

echo "[4/5] Generating SBOM files (CycloneDX JSON)..."
docker run --rm -v "$ROOT_DIR:/src" anchore/syft:v1.4.1 \
  "dir:/src/backend" -o "cyclonedx-json=/src/security-reports/sbom/backend-${STAMP}.cdx.json"
docker run --rm -v "$ROOT_DIR:/src" anchore/syft:v1.4.1 \
  "dir:/src/apps/consumer" -o "cyclonedx-json=/src/security-reports/sbom/consumer-${STAMP}.cdx.json"
docker run --rm -v "$ROOT_DIR:/src" anchore/syft:v1.4.1 \
  "dir:/src/apps/admin" -o "cyclonedx-json=/src/security-reports/sbom/admin-${STAMP}.cdx.json"

echo "[5/5] Running Trivy CRITICAL gate..."
docker run --rm -v "$ROOT_DIR:/repo" aquasec/trivy:0.53.0 fs \
  --scanners vuln,secret \
  --severity CRITICAL \
  --exit-code 1 \
  --format sarif \
  -o "/repo/security-reports/scans/trivy-critical-${STAMP}.sarif" \
  /repo

echo "[OK] Security gate completed."
echo " - reports: ${REPORT_DIR}"
