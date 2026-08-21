#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# preflight-check.sh — 배포 전 핵심 파일 무결성 검증
#
# 용도: CI 파이프라인 또는 수동 배포 전 실행
#       핵심 페이지 파일이 비정상적으로 축소되었거나 누락되었는지 확인
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ERRORS=0

# ---------------------------------------------------------------------------
# 핵심 파일 최소 라인 수 검증
# 형식: "파일경로:최소라인수:설명"
# ---------------------------------------------------------------------------
CRITICAL_FILES=(
  "apps/consumer/src/app/[locale]/page.tsx:50:Consumer 메인페이지"
  "apps/consumer/src/app/[locale]/events/[id]/EventDetailClient.tsx:100:이벤트 상세페이지"
  "apps/consumer/src/app/[locale]/layout.tsx:30:Consumer 레이아웃"
  "apps/admin/src/app/layout.tsx:10:Admin 레이아웃"
  "backend/app/main.py:50:Backend 엔트리포인트"
  "backend/app/services/payment_service.py:100:결제 서비스"
  "backend/app/services/purchase_service.py:100:구매 서비스"
)

echo "=== Pickket Preflight Check ==="
echo ""

for entry in "${CRITICAL_FILES[@]}"; do
  IFS=':' read -r filepath min_lines desc <<< "$entry"
  fullpath="${ROOT_DIR}/${filepath}"

  if [[ ! -f "$fullpath" ]]; then
    echo "[FAIL] ${desc} — 파일 없음: ${filepath}"
    ((ERRORS+=1))
    continue
  fi

  actual_lines=$(wc -l < "$fullpath")
  if (( actual_lines < min_lines )); then
    echo "[FAIL] ${desc} — ${filepath}: ${actual_lines}줄 (최소 ${min_lines}줄 필요)"
    echo "       → 파일이 비정상적으로 축소됨. git diff로 확인 필요"
    ((ERRORS+=1))
  else
    echo "[ OK ] ${desc} — ${filepath}: ${actual_lines}줄"
  fi
done

# ---------------------------------------------------------------------------
# 커밋되지 않은 변경사항 경고 (배포 시)
# ---------------------------------------------------------------------------
echo ""
if git -C "$ROOT_DIR" diff --stat --quiet 2>/dev/null; then
  echo "[ OK ] 커밋되지 않은 변경사항 없음"
else
  echo "[WARN] 커밋되지 않은 변경사항 있음:"
  git -C "$ROOT_DIR" diff --stat 2>/dev/null | head -20
  echo ""
  echo "       → 배포 전 변경사항을 커밋하거나 stash하세요"
fi

echo ""
if (( ERRORS > 0 )); then
  echo "=== PREFLIGHT FAILED: ${ERRORS}개 문제 발견 ==="
  echo "배포를 중단합니다. 위 문제를 해결한 후 다시 시도하세요."
  exit 1
else
  echo "=== PREFLIGHT PASSED ==="
fi
