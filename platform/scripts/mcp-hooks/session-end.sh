#!/usr/bin/env bash
# Claude Code Stop Hook — 세션 종료 시 handoff note 프롬프트
# 오프라인 캐시 동기화도 시도

MCP_SERVER="${MCP_SERVER_URL:-http://localhost:8022}"
TOKEN="${PICKKET_MCP_TOKEN:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CACHE_FILE="${PROJECT_DIR}/.mcp-cache.json"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 세션 종료 전 체크"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  complete_task 툴을 호출해서 handoff note를 남겨주세요."
echo "  다음 세션 또는 팀원이 이어받을 수 있도록:"
echo "    • 완료한 내용 (summary)"
echo "    • 다음에 할 일 (next_steps)"
echo "    • 관련 PR URL (있으면)"
echo ""
echo "  예시:"
echo '  complete_task(task_id="...", summary="OAuth 수정 완료", next_steps="토큰 테스트 필요")'
echo ""

# 오프라인 캐시 동기화 시도
if [ -f "$CACHE_FILE" ] && command -v python3 &>/dev/null; then
  PENDING=$(python3 -c "
import json
try:
    data = json.load(open('$CACHE_FILE'))
    print(len(data.get('pending_sync', [])))
except:
    print(0)
" 2>/dev/null)

  if [ "${PENDING:-0}" -gt 0 ] 2>/dev/null; then
    echo "  💾 오프라인 캐시 ${PENDING}개 항목 동기화 시도 중..."
    # 서버 ping
    if curl -sf --max-time 2 "${MCP_SERVER}/health" > /dev/null 2>&1; then
      python3 -c "
import json, subprocess, os
cache_file = '$CACHE_FILE'
try:
    data = json.load(open(cache_file))
    synced = 0
    for item in data.get('pending_sync', []):
        if item.get('action') == 'lock':
            r = subprocess.run([
                'curl', '-sf', '--max-time', '2', '-X', 'POST',
                '$MCP_SERVER/api/locks',
                '-H', 'Authorization: Bearer $TOKEN',
                '-H', 'Content-Type: application/json',
                '-d', json.dumps({'file': item['file'], 'branch': item.get('branch',''), 'developer': item.get('developer','')})
            ], capture_output=True)
            if r.returncode == 0:
                synced += 1
    data['pending_sync'] = []
    with open(cache_file, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f'  ✅ {synced}개 동기화 완료')
except Exception as e:
    print(f'  동기화 실패: {e}')
" 2>/dev/null
    else
      echo "  서버 미응답 — 다음 세션에서 재시도됩니다."
    fi
  fi
fi

exit 0
