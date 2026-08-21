#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-quick}"
PORT="${DASHBOARD_PORT:-8787}"

if [[ "$MODE" != "quick" && "$MODE" != "full" ]]; then
  echo "Usage: $0 [quick|full]"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASH_SCRIPT="$ROOT_DIR/scripts/project-health-dashboard.sh"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3가 필요합니다. 설치 후 다시 실행하세요."
  exit 1
fi

set +e
bash "$DASH_SCRIPT" "$MODE"
DASH_EXIT=$?
set -e

URL="http://localhost:${PORT}/docs/status/PROJECT_HEALTH_DASHBOARD.html"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
fi

echo ""
echo "Dashboard URL: $URL"
echo "Press Ctrl+C to stop local server."
echo ""

cd "$ROOT_DIR"
python3 -m http.server "$PORT"

exit "$DASH_EXIT"
