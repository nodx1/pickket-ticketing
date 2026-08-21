#!/usr/bin/env bash
# claude-team-sync 팀원 온보딩 스크립트
# 실행: bash scripts/mcp-hooks/setup.sh

set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   claude-team-sync 팀원 설정         ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 기본값 설정
DEFAULT_SERVER="https://mcp-staging.pickket.kr"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "프로젝트 루트: ${PROJECT_DIR}"
echo ""

# 입력 받기
read -p "개발자 이름 (영문, 예: alice): " DEV_NAME
if [ -z "$DEV_NAME" ]; then
  echo "❌ 이름을 입력해야 합니다."
  exit 1
fi

read -sp "MCP 토큰 (관리자에게 받기): " MCP_TOKEN
echo ""
if [ -z "$MCP_TOKEN" ]; then
  echo "⚠️  토큰 없이 계속 (로컬 개발용)"
fi

read -p "MCP 서버 URL [${DEFAULT_SERVER}]: " MCP_SERVER
MCP_SERVER="${MCP_SERVER:-$DEFAULT_SERVER}"

read -p "Lock 모드 [soft/strict, 기본: soft]: " LOCK_MODE
LOCK_MODE="${LOCK_MODE:-soft}"

# shell profile 결정
if [ -f "$HOME/.zshrc" ]; then
  PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  PROFILE="$HOME/.bashrc"
else
  PROFILE="$HOME/.profile"
fi

echo ""
echo "설정을 ${PROFILE}에 추가합니다..."

# 기존 설정 제거 후 추가
if grep -q "# claude-team-sync" "$PROFILE" 2>/dev/null; then
  # 기존 블록 제거 (macOS/Linux 호환)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' '/# claude-team-sync/,/# end claude-team-sync/d' "$PROFILE"
  else
    sed -i '/# claude-team-sync/,/# end claude-team-sync/d' "$PROFILE"
  fi
fi

cat >> "$PROFILE" << EOF

# claude-team-sync
export PICKKET_DEV_NAME="${DEV_NAME}"
export PICKKET_MCP_TOKEN="${MCP_TOKEN}"
export MCP_SERVER_URL="${MCP_SERVER}"
export MCP_LOCK_MODE="${LOCK_MODE}"
export MCP_PROJECT_ROOT="${PROJECT_DIR}"
# end claude-team-sync
EOF

# mcp-team.yml project_root 업데이트
YML_FILE="${PROJECT_DIR}/packages/mcp-dev-server/mcp-team.example.yml"
if [ -f "$YML_FILE" ] && command -v python3 &>/dev/null; then
  python3 -c "
import re
with open('$YML_FILE') as f:
    content = f.read()
content = re.sub(
    r'project_root:.*',
    'project_root: \"$PROJECT_DIR\"',
    content
)
with open('$YML_FILE', 'w') as f:
    f.write(content)
print('mcp-team.yml project_root 업데이트됨')
" 2>/dev/null || true
fi

# 서버 연결 테스트
echo ""
echo "서버 연결 테스트..."
if curl -sf --max-time 5 "${MCP_SERVER}/health" > /dev/null 2>&1; then
  echo "✅ 서버 연결 성공"
else
  echo "⚠️  서버 미응답 (나중에 배포 후 연결 가능)"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   설정 완료!                          ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  개발자: ${DEV_NAME}"
echo "  서버: ${MCP_SERVER}"
echo "  Lock 모드: ${LOCK_MODE}"
echo ""
echo "  다음 단계:"
echo "  1. 터미널 재시작: source ${PROFILE}"
echo "  2. Claude Code 재시작"
echo "  3. 세션 시작 시 dev_status 호출"
echo ""
echo "  대시보드: https://admin.pickket.kr/dev"
echo ""
