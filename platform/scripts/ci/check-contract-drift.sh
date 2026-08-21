#!/bin/bash
# 공유 타입 재정의 감지 + 금지 용어 검사
# packages/lib/src/types/에 정의된 인터페이스가 mobile api.ts에 재정의되면 실패
# extends 패턴은 허용 (모바일 확장 필드)
# 금지 용어(dutch, vcg_auction, mileage.*auction)가 앱 코드에 남아있으면 실패

set -euo pipefail

MOBILE_DIR="${MOBILE_DIR:-../pickket.v2.app}"
TYPES_DIR="packages/lib/src/types"
EXIT_CODE=0

echo "=== Contract Drift Check ==="

# 0. Codegen freshness — generated/ 가 백엔드 SSOT와 최신 상태인지 확인
echo ""
echo "=== Codegen Freshness (generated contracts) ==="
PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x "backend/.venv/bin/python" ]; then
    PYTHON_BIN="backend/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    PYTHON_BIN="python"
  fi
fi

if "$PYTHON_BIN" scripts/codegen/generate_ts_contracts.py; then
  if ! git diff --exit-code -- packages/lib/src/contracts/generated/; then
    echo "ERROR: generated contracts are stale — run scripts/codegen/generate_ts_contracts.py and commit."
    EXIT_CODE=1
  else
    echo "PASS: generated contracts are up to date with backend SSOT"
  fi
else
  echo "ERROR: codegen script failed to run"
  EXIT_CODE=1
fi

# 1. 공유 타입 재정의 검사 (extends 패턴은 허용)
if [ -d "$MOBILE_DIR/src/config" ]; then
  # 모바일에서 의도적으로 확장 Ticket 타입을 사용하는 응답 타입
  ALLOWED_OVERRIDES="TicketListResponse"
  SHARED_TYPES=$(grep -ohP 'export (interface|type) \K\w+' "$TYPES_DIR"/*.ts 2>/dev/null | sort -u)
  for t in $SHARED_TYPES; do
    if echo "$ALLOWED_OVERRIDES" | grep -qw "$t"; then continue; fi
    # extends V2... 패턴은 의도적 확장이므로 허용
    MATCH=$(grep -P "^export interface $t\b" "$MOBILE_DIR/src/config/api.ts" 2>/dev/null || true)
    if [ -n "$MATCH" ]; then
      if echo "$MATCH" | grep -qP "extends\s+"; then
        continue  # extends 패턴은 의도적 확장 (V2 타입 또는 로컬 확장)
      fi
      echo "ERROR: '$t' redefined in mobile api.ts — use import from @pickket/lib/types"
      EXIT_CODE=1
    fi
  done

  if [ $EXIT_CODE -eq 0 ]; then
    echo "PASS: No shared type redefinitions found"
  fi
else
  echo "SKIP: Mobile directory not found at $MOBILE_DIR (expected in cross-repo CI)"
fi

# 2. 금지 용어 검사 (v2 코드 — 테스트/contracts 제외)
echo ""
echo "=== Banned Terms Check (v2) ==="
BANNED=$(grep -rnE '\b(dutch|vcg_auction|mileage.*auction)\b' \
  packages/lib/src/ apps/consumer/src/ apps/admin/src/ 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v '__tests__' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  | grep -v 'contracts/' \
  | grep -v '// legacy' \
  | grep -v 'vcg_price' \
  || true)

if [ -n "$BANNED" ]; then
  echo "ERROR: Banned terms found in v2 code:"
  echo "$BANNED"
  EXIT_CODE=1
else
  echo "PASS: No banned terms in v2 code"
fi

# 3. 금지 용어 검사 (모바일 코드 — 테스트 제외)
if [ -d "$MOBILE_DIR/src" ]; then
  echo ""
  echo "=== Banned Terms Check (mobile) ==="
  BANNED_MOBILE=$(grep -rnE '\b(dutch|vcg_auction|mileage.*auction)\b' \
    "$MOBILE_DIR/src/" 2>/dev/null \
    | grep -v 'node_modules' \
    | grep -v '__tests__' \
    | grep -v '\.test\.' \
    | grep -v '\.spec\.' \
    | grep -v '// legacy' \
    | grep -v 'vcg_price' \
    || true)

  if [ -n "$BANNED_MOBILE" ]; then
    echo "ERROR: Banned terms found in mobile code:"
    echo "$BANNED_MOBILE"
    EXIT_CODE=1
  else
    echo "PASS: No banned terms in mobile code"
  fi
fi

# 4. 백엔드 서비스/API 레이어 — 사용자 노출 sale_mode 값 금지어 검사
#    내부 엔진 알고리즘 이름(VCG/Dutch)은 허용되지만, sale_mode 값으로 쓰는 것은 금지.
echo ""
echo "=== Banned sale_mode writes (backend) ==="
BANNED_BACKEND=$(grep -rnE 'sale_mode\s*=\s*["\x27](vcg_auction|dutch_auction|auction)["\x27]' \
  backend/app/services/ backend/app/api/ 2>/dev/null \
  | grep -v '__pycache__' \
  | grep -v '\.pyc' \
  || true)

if [ -n "$BANNED_BACKEND" ]; then
  echo "ERROR: Banned sale_mode values written in backend:"
  echo "$BANNED_BACKEND"
  echo "Use canonical values: fanclub_presale | point_lottery | queue | fixed_fcfs"
  EXIT_CODE=1
else
  echo "PASS: No banned sale_mode writes in backend"
fi

# 5. i18n 키 이름에 금지 용어 (값이 아닌 키 식별자)
echo ""
echo "=== Banned i18n keys (consumer) ==="
BANNED_I18N=""
if [ -d "apps/consumer/messages" ]; then
  BANNED_I18N=$(grep -rnE '^\s*"(vcg[a-zA-Z_]*|dutch[a-zA-Z_]*|saleModeDutch|saleModeAuction|vcgPrice|tab_vcg)"\s*:' \
    apps/consumer/messages/ 2>/dev/null || true)
fi

if [ -n "$BANNED_I18N" ]; then
  echo "ERROR: Banned terms used as i18n key names:"
  echo "$BANNED_I18N"
  EXIT_CODE=1
else
  echo "PASS: No banned i18n key names"
fi

exit $EXIT_CODE
