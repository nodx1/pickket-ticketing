#!/usr/bin/env bash
# Claude Code PreToolUse Hook — 파일 편집 직전 충돌 감지
# 환경변수: CLAUDE_TOOL_INPUT_FILE_PATH (편집 대상 파일 절대경로)

FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
MCP_SERVER="${MCP_SERVER_URL:-http://localhost:8022}"
TOKEN="${PICKKET_MCP_TOKEN:-}"
DEV="${PICKKET_DEV_NAME:-unknown}"
CACHE_FILE="${CLAUDE_PROJECT_DIR:-.}/.mcp-cache.json"

# 파일 경로 없으면 스킵
[ -z "$FILE" ] && exit 0

# 서버 호출 시도 (타임아웃 2초)
RESPONSE=$(curl -sf --max-time 2 \
  "${MCP_SERVER}/api/conflicts?files=${FILE}" \
  -H "Authorization: Bearer ${TOKEN}" 2>/dev/null)

if [ $? -ne 0 ]; then
  # 오프라인: 로컬 캐시 확인
  if [ -f "$CACHE_FILE" ] && command -v python3 &>/dev/null; then
    CACHED_OWNER=$(python3 -c "
import json, sys, os
try:
    data = json.load(open('$CACHE_FILE'))
    locks = data.get('locks', {})
    # 파일 경로 정규화 (절대→상대)
    rel_file = os.path.relpath('$FILE', data.get('project_root', '.'))
    info = locks.get(rel_file) or locks.get('$FILE')
    if info and info.get('developer') != '$DEV':
        print(info.get('developer', ''))
except:
    pass
" 2>/dev/null)
    if [ -n "$CACHED_OWNER" ]; then
      echo "⚠️  [오프라인 캐시] $(basename "$FILE") — ${CACHED_OWNER} 작업 중"
    fi
  fi
  exit 0  # 서버 다운돼도 개발 블로킹하지 않음
fi

# 충돌 확인
HAS_CONFLICT=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    conflicts = d.get('conflicts', [])
    for c in conflicts:
        if c.get('owner') != '$DEV':
            print(c.get('owner', ''), c.get('branch', '-'), c.get('file', ''))
            break
except:
    pass
" 2>/dev/null)

if [ -n "$HAS_CONFLICT" ]; then
  OWNER=$(echo "$HAS_CONFLICT" | awk '{print $1}')
  BRANCH=$(echo "$HAS_CONFLICT" | awk '{print $2}')
  echo "⚠️  충돌: $(basename "$FILE") → ${OWNER} 작업 중 (branch: ${BRANCH})"

  # strict 모드: 편집 블로킹
  if [ "${MCP_LOCK_MODE:-soft}" = "strict" ]; then
    echo "   strict 모드: 편집이 차단되었습니다."
    echo "   force_unlock MCP 툴 또는 ${OWNER}와 협의 후 진행하세요."
    exit 1
  fi
fi

exit 0
