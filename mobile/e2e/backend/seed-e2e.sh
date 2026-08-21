#!/usr/bin/env bash
# E2E 픽스쳐 시드 — v2 백엔드에 테스트용 계정·이벤트·티켓 투입
# 사용: bash e2e/backend/seed-e2e.sh
set -euo pipefail

BACKEND_DIR="${PICKKET_V2_BACKEND:-/home/oem/Desktop/pickket.v2/backend}"

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "❌ v2 backend 경로를 찾을 수 없음: $BACKEND_DIR"
  echo "   PICKKET_V2_BACKEND 환경변수로 지정하세요"
  exit 1
fi

echo "▶ v2 백엔드 경로: $BACKEND_DIR"

cd "$BACKEND_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi

if [[ -z "${PYTHON_BIN:-}" ]]; then
  echo "❌ Python 실행 파일을 찾을 수 없음"
  exit 1
fi

echo "▶ seed_demo.py 실행"
if "$PYTHON_BIN" scripts/seed_demo.py 2>&1; then
  echo "✅ demo 시드 완료"
else
  echo "❌ 시드 실패 — seed_demo.py 실행 에러"
  exit 1
fi

echo "▶ seed_local.py 실행"
if "$PYTHON_BIN" scripts/seed_local.py 2>&1; then
  echo "✅ local 사용자 여정 시드 완료"
else
  echo "❌ 시드 실패 — seed_local.py 실행 에러"
  exit 1
fi

# 모바일 E2E 전용 계정 확인
echo ""
echo "▶ 모바일 E2E 고정 계정"
echo "   email:    fan1@test.pickket.kr"
echo "   password: PickketTest2026!"
echo "   ※ 이 계정이 없으면 e2e/shared/login-consumer.yaml 이 실패합니다"
