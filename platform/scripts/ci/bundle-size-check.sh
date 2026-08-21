#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# bundle-size-check.sh
# Consumer .next/static 번들 크기를 합산하고 임계값 초과 시 경고 출력
# 사용법: bash scripts/ci/bundle-size-check.sh [static-dir]
# ---------------------------------------------------------------------------
set -euo pipefail

# 기본값: apps/consumer/.next/static
STATIC_DIR="${1:-apps/consumer/.next/static}"
# 임계값 (KB). 환경변수로 오버라이드 가능
THRESHOLD_KB="${BUNDLE_SIZE_THRESHOLD_KB:-500}"

if [ ! -d "$STATIC_DIR" ]; then
  echo "::error::Static directory not found: $STATIC_DIR"
  echo "빌드가 먼저 실행되어야 합니다."
  exit 1
fi

# JS 파일 크기 합산 (KB 단위)
CHUNKS_DIR="$STATIC_DIR/chunks"
if [ -d "$CHUNKS_DIR" ]; then
  JS_SIZE_BYTES=$(find "$CHUNKS_DIR" -name '*.js' -type f -exec stat --format='%s' {} + 2>/dev/null | paste -sd+ | bc)
else
  JS_SIZE_BYTES=$(find "$STATIC_DIR" -name '*.js' -type f -exec stat --format='%s' {} + 2>/dev/null | paste -sd+ | bc)
fi

JS_SIZE_KB=$((JS_SIZE_BYTES / 1024))

# CSS 파일 크기 합산 (KB 단위)
CSS_SIZE_BYTES=$(find "$STATIC_DIR" -name '*.css' -type f -exec stat --format='%s' {} + 2>/dev/null | paste -sd+ | bc || echo 0)
CSS_SIZE_KB=$((CSS_SIZE_BYTES / 1024))

TOTAL_KB=$((JS_SIZE_KB + CSS_SIZE_KB))

echo "=========================================="
echo "  Bundle Size Report"
echo "=========================================="
echo "  Directory : $STATIC_DIR"
echo "  JS size   : ${JS_SIZE_KB} KB"
echo "  CSS size  : ${CSS_SIZE_KB} KB"
echo "  Total     : ${TOTAL_KB} KB"
echo "  Threshold : ${THRESHOLD_KB} KB"
echo "=========================================="

# 상위 10개 큰 JS 파일 출력
echo ""
echo "Top 10 largest JS files:"
if [ -d "$CHUNKS_DIR" ]; then
  find "$CHUNKS_DIR" -name '*.js' -type f -exec du -k {} + 2>/dev/null | sort -rn | head -10 || true
else
  find "$STATIC_DIR" -name '*.js' -type f -exec du -k {} + 2>/dev/null | sort -rn | head -10 || true
fi

echo ""

if [ "$TOTAL_KB" -gt "$THRESHOLD_KB" ]; then
  echo "::warning::Bundle size (${TOTAL_KB} KB) exceeds threshold (${THRESHOLD_KB} KB)!"
  echo "번들 크기가 임계값을 초과했습니다. 코드 스플리팅이나 트리 쉐이킹을 검토하세요."
  # warning만 출력 (CI 실패시키지는 않음)
  exit 0
else
  echo "Bundle size is within threshold. OK"
fi
