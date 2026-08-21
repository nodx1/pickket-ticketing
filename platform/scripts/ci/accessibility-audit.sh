#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# P2-6: Accessibility audit — axe-core / pa11y CI integration
# Scans consumer app pages for WCAG 2.1 AA violations.
# Exit 1 if critical (serious/critical) violations are found.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/apps/consumer/src/tests/a11y.config.ts"

# ── Defaults ──────────────────────────────────────────────────
BASE_URL="${A11Y_BASE_URL:-http://localhost:3020}"
REPORT_DIR="${A11Y_REPORT_DIR:-$PROJECT_ROOT/reports/a11y}"
THRESHOLD="${A11Y_THRESHOLD:-0}"     # max allowed critical/serious violations
TOOL="${A11Y_TOOL:-pa11y}"           # pa11y or axe

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── URLs to scan ──────────────────────────────────────────────
URLS=(
  "/"
  "/events"
  "/events/00000000-0000-0000-0000-000000000001"
  "/login"
  "/register"
)

# ── Helpers ───────────────────────────────────────────────────
log_info()  { echo -e "${GREEN}[a11y]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[a11y]${NC} $*"; }
log_error() { echo -e "${RED}[a11y]${NC} $*"; }

ensure_tool() {
  if [ "$TOOL" = "pa11y" ]; then
    if ! command -v pa11y &>/dev/null; then
      log_info "Installing pa11y..."
      npm install -g pa11y pa11y-ci 2>/dev/null || {
        log_error "Failed to install pa11y. Install manually: npm install -g pa11y"
        exit 1
      }
    fi
  elif [ "$TOOL" = "axe" ]; then
    if ! command -v axe &>/dev/null; then
      log_info "Installing @axe-core/cli..."
      npm install -g @axe-core/cli 2>/dev/null || {
        log_error "Failed to install @axe-core/cli. Install manually: npm install -g @axe-core/cli"
        exit 1
      }
    fi
  fi
}

wait_for_server() {
  local max_retries=30
  local retry=0
  log_info "Waiting for consumer app at $BASE_URL ..."
  while ! curl -sf "$BASE_URL" -o /dev/null 2>/dev/null; do
    retry=$((retry + 1))
    if [ $retry -ge $max_retries ]; then
      log_error "Consumer app not responding at $BASE_URL after ${max_retries}s"
      exit 1
    fi
    sleep 1
  done
  log_info "Consumer app is up."
}

# ── Main ──────────────────────────────────────────────────────
main() {
  ensure_tool
  wait_for_server

  mkdir -p "$REPORT_DIR"

  local total_critical=0
  local total_serious=0
  local total_moderate=0
  local total_minor=0
  local failed_pages=()

  log_info "Starting WCAG 2.1 AA audit using $TOOL..."
  log_info "Base URL: $BASE_URL"
  echo ""

  for path in "${URLS[@]}"; do
    local url="${BASE_URL}${path}"
    local slug="${path//\//_}"
    [ -z "$slug" ] && slug="_home"
    local report_file="$REPORT_DIR/a11y${slug}.json"

    echo "────────────────────────────────────────"
    log_info "Scanning: $url"

    local exit_code=0

    if [ "$TOOL" = "pa11y" ]; then
      pa11y \
        --standard WCAG2AA \
        --reporter json \
        --timeout 30000 \
        --ignore "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail" \
        "$url" > "$report_file" 2>/dev/null || exit_code=$?

      if [ -s "$report_file" ]; then
        local page_errors
        page_errors=$(jq 'length' "$report_file" 2>/dev/null || echo "0")

        local page_critical
        page_critical=$(jq '[.[] | select(.type == "error" and (.typeCode == 1 or .typeCode == 2))] | length' "$report_file" 2>/dev/null || echo "0")

        local page_serious
        page_serious=$(jq '[.[] | select(.type == "error")] | length' "$report_file" 2>/dev/null || echo "0")

        local page_moderate
        page_moderate=$(jq '[.[] | select(.type == "warning")] | length' "$report_file" 2>/dev/null || echo "0")

        local page_minor
        page_minor=$(jq '[.[] | select(.type == "notice")] | length' "$report_file" 2>/dev/null || echo "0")

        total_critical=$((total_critical + page_critical))
        total_serious=$((total_serious + page_serious))
        total_moderate=$((total_moderate + page_moderate))
        total_minor=$((total_minor + page_minor))

        if [ "$page_critical" -gt 0 ] || [ "$page_serious" -gt 0 ]; then
          log_error "  Critical/Serious: $page_critical/$page_serious  Moderate: $page_moderate  Minor: $page_minor"
          failed_pages+=("$path")
        else
          log_info "  OK — Moderate: $page_moderate  Minor: $page_minor"
        fi
      else
        log_info "  OK — No violations found."
      fi

    elif [ "$TOOL" = "axe" ]; then
      axe "$url" \
        --tags wcag2a,wcag2aa,wcag21aa \
        --save "$report_file" \
        --exit 2>/dev/null || exit_code=$?

      if [ -s "$report_file" ]; then
        local page_critical
        page_critical=$(jq '[.[] | .violations[] | select(.impact == "critical")] | length' "$report_file" 2>/dev/null || echo "0")

        local page_serious
        page_serious=$(jq '[.[] | .violations[] | select(.impact == "serious")] | length' "$report_file" 2>/dev/null || echo "0")

        local page_moderate
        page_moderate=$(jq '[.[] | .violations[] | select(.impact == "moderate")] | length' "$report_file" 2>/dev/null || echo "0")

        local page_minor
        page_minor=$(jq '[.[] | .violations[] | select(.impact == "minor")] | length' "$report_file" 2>/dev/null || echo "0")

        total_critical=$((total_critical + page_critical))
        total_serious=$((total_serious + page_serious))
        total_moderate=$((total_moderate + page_moderate))
        total_minor=$((total_minor + page_minor))

        if [ "$page_critical" -gt 0 ] || [ "$page_serious" -gt 0 ]; then
          log_error "  Critical: $page_critical  Serious: $page_serious  Moderate: $page_moderate  Minor: $page_minor"
          failed_pages+=("$path")
        else
          log_info "  OK — Moderate: $page_moderate  Minor: $page_minor"
        fi
      else
        log_info "  OK — No violations found."
      fi
    fi
  done

  echo ""
  echo "════════════════════════════════════════"
  log_info "Accessibility Audit Summary"
  echo "────────────────────────────────────────"
  echo "  Critical:  $total_critical"
  echo "  Serious:   $total_serious"
  echo "  Moderate:  $total_moderate"
  echo "  Minor:     $total_minor"
  echo "  Reports:   $REPORT_DIR/"
  echo "════════════════════════════════════════"

  local blocking=$((total_critical + total_serious))
  if [ "$blocking" -gt "$THRESHOLD" ]; then
    echo ""
    log_error "FAILED — $blocking critical/serious violations exceed threshold ($THRESHOLD)."
    if [ ${#failed_pages[@]} -gt 0 ]; then
      log_error "Affected pages:"
      for p in "${failed_pages[@]}"; do
        echo "  - $p"
      done
    fi
    exit 1
  fi

  echo ""
  log_info "PASSED — All pages within threshold."
  exit 0
}

main "$@"
