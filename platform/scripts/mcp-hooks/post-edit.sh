#!/usr/bin/env bash
# Claude Code PostToolUse Hook — 파일 편집 직후 파일 락 등록
# 환경변수: CLAUDE_TOOL_INPUT_FILE_PATH (편집된 파일 절대경로)

FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
MCP_SERVER="${MCP_SERVER_URL:-http://localhost:8022}"
TOKEN="${PICKKET_MCP_TOKEN:-}"
DEV="${PICKKET_DEV_NAME:-unknown}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CACHE_FILE="${PROJECT_DIR}/.mcp-cache.json"

[ -z "$FILE" ] && exit 0

# 현재 git 브랜치
BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "unknown")

# 서버에 파일 락 등록 시도 (타임아웃 2초)
curl -sf --max-time 2 -X POST "${MCP_SERVER}/api/locks" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"file\": \"${FILE}\", \"branch\": \"${BRANCH}\", \"developer\": \"${DEV}\"}" \
  > /dev/null 2>&1

if [ $? -ne 0 ]; then
  # 오프라인: 로컬 캐시에 저장
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, os, datetime
cache_file = '$CACHE_FILE'
try:
    data = json.load(open(cache_file)) if os.path.exists(cache_file) else {}
except:
    data = {}
data.setdefault('locks', {})
data.setdefault('project_root', '$PROJECT_DIR')
data.setdefault('pending_sync', [])
# 상대 경로로 정규화
rel = os.path.relpath('$FILE', data.get('project_root', '$PROJECT_DIR'))
data['locks'][rel] = {
    'developer': '$DEV',
    'branch': '$BRANCH',
    'locked_at': datetime.datetime.utcnow().isoformat()
}
data['pending_sync'].append({'action': 'lock', 'file': rel, 'developer': '$DEV', 'branch': '$BRANCH'})
with open(cache_file, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" 2>/dev/null
  fi
fi

exit 0
