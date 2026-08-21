#!/usr/bin/env bash
# ── 타이포그래피 정책 린트 ──────────────────────────────────────
# 하드코딩 픽셀 폰트 사이즈 및 font-tabular 누락 검사
# 사용: bash scripts/ci/check-typography.sh
set -euo pipefail

ERRORS=0

# 1. 하드코딩 픽셀 폰트 사이즈 금지
#    text-2xs / text-xs-plus / text-sm-minus / 표준 Tailwind 클래스 사용
HARDCODED=$(grep -rn 'text-\[[0-9]*px\]' apps/ packages/ --include='*.tsx' --include='*.ts' --exclude-dir=node_modules 2>/dev/null || true)
if [ -n "$HARDCODED" ]; then
  echo "❌ 하드코딩 폰트 사이즈 발견:"
  echo "$HARDCODED"
  echo ""
  echo "→ text-[10px] → text-2xs"
  echo "→ text-[11px] → text-xs-plus"
  echo "→ text-[13px] → text-sm-minus"
  echo "→ text-[18px] → text-lg"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# 2. formatKRW/formatCurrency 사용 파일에 font-tabular 또는 data-slot="price" 필수
#    제외: 테스트 파일, 차트 콜백 전용 파일 (JSX className 불가)
PRICE_FILES=$(grep -rl 'formatKRW\|formatCurrency' apps/ --include='*.tsx' --exclude-dir=node_modules --exclude-dir=__tests__ 2>/dev/null || true)
for f in $PRICE_FILES; do
  # 차트 라이브러리 콜백에서만 formatKRW 사용하는 파일 제외
  case "$f" in *PriceChart.tsx) continue ;; esac
  # KpiCard 컴포넌트가 내부적으로 font-tabular 적용
  if ! grep -q 'font-tabular\|data-slot="price"\|data-slot="stat"\|data-slot="count"\|KpiCard' "$f"; then
    echo "❌ $f: formatKRW/formatCurrency 사용하지만 font-tabular 미적용"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -eq 0 ]; then
  echo "✅ 타이포그래피 정책 검사 통과"
fi

exit "$ERRORS"
