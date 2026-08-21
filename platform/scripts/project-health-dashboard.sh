#!/usr/bin/env bash
set -u

MODE="${1:-quick}"
if [[ "$MODE" != "quick" && "$MODE" != "full" ]]; then
  echo "Usage: $0 [quick|full]"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/docs/status"
OUTPUT_FILE="$OUTPUT_DIR/PROJECT_HEALTH_DASHBOARD.md"
OUTPUT_HTML="$OUTPUT_DIR/PROJECT_HEALTH_DASHBOARD.html"
API_HEALTH_URL="${API_HEALTH_URL:-${NEXT_PUBLIC_API_URL:-http://localhost:8001}}"
mkdir -p "$OUTPUT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

declare -a AREAS=()
declare -a NAMES=()
declare -a STATUSES=()
declare -a CMDS=()
declare -a HINTS=()
declare -a LOGS=()

escape_html() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  s="${s//\'/&#39;}"
  printf '%s' "$s"
}

record_result() {
  AREAS+=("$1")
  NAMES+=("$2")
  STATUSES+=("$3")
  CMDS+=("$4")
  HINTS+=("$5")
  LOGS+=("$6")
}

run_required() {
  local area="$1"
  local name="$2"
  local cmd="$3"
  local hint="$4"
  local log_file="$TMP_DIR/${#NAMES[@]}.log"

  if (cd "$ROOT_DIR" && eval "$cmd") >"$log_file" 2>&1; then
    record_result "$area" "$name" "PASS" "$cmd" "$hint" "$log_file"
  else
    record_result "$area" "$name" "FAIL" "$cmd" "$hint" "$log_file"
  fi
}

run_optional() {
  local area="$1"
  local name="$2"
  local cmd="$3"
  local hint="$4"
  local log_file="$TMP_DIR/${#NAMES[@]}.log"

  if (cd "$ROOT_DIR" && eval "$cmd") >"$log_file" 2>&1; then
    record_result "$area" "$name" "PASS" "$cmd" "$hint" "$log_file"
  else
    record_result "$area" "$name" "WARN" "$cmd" "$hint" "$log_file"
  fi
}

record_skip() {
  local area="$1"
  local name="$2"
  local cmd="$3"
  local hint="$4"
  local log_file="$TMP_DIR/${#NAMES[@]}.log"
  echo "Skipped: $hint" >"$log_file"
  record_result "$area" "$name" "SKIP" "$cmd" "$hint" "$log_file"
}

pass_count=0
fail_count=0
warn_count=0
skip_count=0

increment_counts() {
  for status in "${STATUSES[@]}"; do
    case "$status" in
      PASS) ((pass_count+=1)) ;;
      FAIL) ((fail_count+=1)) ;;
      WARN) ((warn_count+=1)) ;;
      SKIP) ((skip_count+=1)) ;;
    esac
  done
}

git_dirty_count="N/A"
if command -v git >/dev/null 2>&1; then
  git_dirty_count="$(cd "$ROOT_DIR" && git status --porcelain | wc -l | tr -d ' ')"
fi

run_required "Workspace" "PNPM install state" "pnpm -s install --frozen-lockfile" "의존성 잠금 파일과 설치 상태를 먼저 맞추세요."
run_required "Code Quality" "Monorepo lint" "pnpm lint" "lint 에러를 우선 해결하세요."
run_required "Unit Tests" "Consumer tests" "pnpm --filter @pickket/consumer test" "consumer 테스트 깨짐을 먼저 수정하세요."
run_required "Unit Tests" "Admin tests" "pnpm --filter @pickket/admin test" "admin 테스트 깨짐을 먼저 수정하세요."
run_required "Infra" "Docker Compose config" "REDIS_PASSWORD=dummy POSTGRES_PASSWORD=dummy docker compose -f docker/docker-compose.yml config --quiet" "docker compose 환경 변수/문법을 점검하세요."
run_required "Docs" "Core runbooks present" "test -f docs/DEPLOYMENT.md && test -f docs/RUNBOOK.md" "배포/운영 문서 경로를 확인하세요."

if [[ "$MODE" == "full" ]]; then
  run_required "Build" "Monorepo build" "pnpm run build" "빌드 실패 앱의 import/type 오류를 수정하세요."

  if [[ -x "$ROOT_DIR/backend/.venv/bin/python" ]]; then
    run_required "Backend" "Pytest full suite" "cd backend && .venv/bin/python -m pytest --tb=short -q" "백엔드 회귀 테스트 실패를 해결하세요."
  else
    record_skip "Backend" "Pytest full suite" "cd backend && .venv/bin/python -m pytest --tb=short -q" "backend/.venv가 없어 pytest를 건너뜁니다."
  fi
else
  if [[ -x "$ROOT_DIR/backend/.venv/bin/python" ]]; then
    run_optional "Backend" "Pytest smoke (auth)" "cd backend && .venv/bin/python -m pytest app/tests/test_auth.py --tb=short -q" "빠른 확인용 auth 스모크 테스트입니다."
  else
    record_skip "Backend" "Pytest smoke (auth)" "cd backend && .venv/bin/python -m pytest app/tests/test_auth.py --tb=short -q" "backend/.venv가 없어 pytest 스모크를 건너뜁니다."
  fi
fi

run_optional "Runtime" "Local API /health" "curl -fsS --max-time 2 ${API_HEALTH_URL}/health >/dev/null" "백엔드가 실행 중이 아니면 WARN입니다. 필요시 무시 가능합니다."

increment_counts

generated_at="$(date '+%Y-%m-%d %H:%M:%S %Z')"

{
  echo "# Project Health Dashboard"
  echo
  echo "- generated_at: $generated_at"
  echo "- mode: $MODE"
  echo "- git_dirty_files: $git_dirty_count"
  echo
  echo "## Summary"
  echo
  echo "| PASS | FAIL | WARN | SKIP |"
  echo "| ---: | ---: | ---: | ---: |"
  echo "| $pass_count | $fail_count | $warn_count | $skip_count |"
  echo
  echo "## Command Results"
  echo
  echo "| Area | Check | Status | Command |"
  echo "| --- | --- | --- | --- |"
  for i in "${!NAMES[@]}"; do
    echo "| ${AREAS[$i]} | ${NAMES[$i]} | ${STATUSES[$i]} | \`${CMDS[$i]}\` |"
  done
  echo

  echo "## Actionable TODO"
  echo
  if [[ "$fail_count" -eq 0 && "$warn_count" -eq 0 ]]; then
    echo "- [x] 현재 자동 점검 항목은 모두 통과했습니다."
  else
    for i in "${!NAMES[@]}"; do
      if [[ "${STATUSES[$i]}" == "FAIL" || "${STATUSES[$i]}" == "WARN" ]]; then
        echo "- [ ] [${STATUSES[$i]}] ${NAMES[$i]} - ${HINTS[$i]}"
      fi
    done
  fi
  echo

  echo "## Detailed Logs (Failed/Warned Checks)"
  echo
  if [[ "$fail_count" -eq 0 && "$warn_count" -eq 0 ]]; then
    echo "- 실패/경고 로그가 없습니다."
  else
    for i in "${!NAMES[@]}"; do
      if [[ "${STATUSES[$i]}" == "FAIL" || "${STATUSES[$i]}" == "WARN" ]]; then
        echo "### ${NAMES[$i]} (${STATUSES[$i]})"
        echo
        echo '```text'
        tail -n 80 "${LOGS[$i]}"
        echo '```'
        echo
      fi
    done
  fi

  echo "## Next Docs"
  echo
  echo "- 상세 체크리스트: \`docs/checklists/MASTER_PROJECT_CHECKLIST.md\`"
  echo "- 릴리즈 게이트: \`docs/checklists/RELEASE_QA_GATE.md\`"
  echo "- 개발 TODO 보드: \`docs/checklists/DEVELOPMENT_TODO_BOARD.md\`"
  echo "- 운영/장애 대응: \`docs/RUNBOOK.md\`"
  echo "- 배포 절차: \`docs/DEPLOYMENT.md\`"
} > "$OUTPUT_FILE"

{
  cat <<EOF
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Health Dashboard</title>
  <style>
    :root {
      --bg: #0b0d12;
      --panel: #121722;
      --panel-2: #0f1420;
      --text: #e6edf7;
      --muted: #9caac0;
      --line: #283246;
      --pass: #16a34a;
      --fail: #dc2626;
      --warn: #d97706;
      --skip: #64748b;
    }
    body {
      margin: 0;
      font-family: "Pretendard", "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    h1, h2, h3 { margin: 0 0 12px; }
    .meta, .links { color: var(--muted); margin: 0 0 6px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 16px 0 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
    }
    .card .label { color: var(--muted); font-size: 12px; }
    .card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    th, td {
      padding: 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th { background: var(--panel-2); color: var(--muted); }
    tr:last-child td { border-bottom: none; }
    .status {
      font-weight: 700;
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
    }
    .PASS { background: rgba(22,163,74,.18); color: #4ade80; }
    .FAIL { background: rgba(220,38,38,.18); color: #f87171; }
    .WARN { background: rgba(217,119,6,.18); color: #fbbf24; }
    .SKIP { background: rgba(100,116,139,.18); color: #cbd5e1; }
    pre {
      margin: 0 0 16px;
      padding: 12px;
      background: #0a0f1a;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
      font-size: 12px;
      color: #dbe6f7;
    }
    code {
      background: #0a0f1a;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 1px 6px;
    }
    .todo li { margin-bottom: 8px; }
    .section { margin: 24px 0 16px; }
    a { color: #93c5fd; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Project Health Dashboard</h1>
    <p class="meta">generated_at: $(escape_html "$generated_at")</p>
    <p class="meta">mode: $(escape_html "$MODE")</p>
    <p class="meta">git_dirty_files: $(escape_html "$git_dirty_count")</p>

    <div class="grid">
      <div class="card"><div class="label">PASS</div><div class="value" style="color:var(--pass)">$pass_count</div></div>
      <div class="card"><div class="label">FAIL</div><div class="value" style="color:var(--fail)">$fail_count</div></div>
      <div class="card"><div class="label">WARN</div><div class="value" style="color:var(--warn)">$warn_count</div></div>
      <div class="card"><div class="label">SKIP</div><div class="value" style="color:var(--skip)">$skip_count</div></div>
    </div>

    <div class="section">
      <h2>Command Results</h2>
      <table>
        <thead>
          <tr>
            <th>Area</th>
            <th>Check</th>
            <th>Status</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody>
EOF
  for i in "${!NAMES[@]}"; do
    printf '          <tr><td>%s</td><td>%s</td><td><span class="status %s">%s</span></td><td><code>%s</code></td></tr>\n' \
      "$(escape_html "${AREAS[$i]}")" \
      "$(escape_html "${NAMES[$i]}")" \
      "$(escape_html "${STATUSES[$i]}")" \
      "$(escape_html "${STATUSES[$i]}")" \
      "$(escape_html "${CMDS[$i]}")"
  done
  cat <<EOF
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Actionable TODO</h2>
      <ul class="todo">
EOF
  if [[ "$fail_count" -eq 0 && "$warn_count" -eq 0 ]]; then
    echo "        <li>[x] 현재 자동 점검 항목은 모두 통과했습니다.</li>"
  else
    for i in "${!NAMES[@]}"; do
      if [[ "${STATUSES[$i]}" == "FAIL" || "${STATUSES[$i]}" == "WARN" ]]; then
        printf '        <li>[ ] [%s] %s - %s</li>\n' \
          "$(escape_html "${STATUSES[$i]}")" \
          "$(escape_html "${NAMES[$i]}")" \
          "$(escape_html "${HINTS[$i]}")"
      fi
    done
  fi
  cat <<EOF
      </ul>
    </div>

    <div class="section">
      <h2>Detailed Logs (Failed/Warned Checks)</h2>
EOF
  if [[ "$fail_count" -eq 0 && "$warn_count" -eq 0 ]]; then
    echo "      <p class=\"meta\">실패/경고 로그가 없습니다.</p>"
  else
    for i in "${!NAMES[@]}"; do
      if [[ "${STATUSES[$i]}" == "FAIL" || "${STATUSES[$i]}" == "WARN" ]]; then
        printf '      <h3>%s (%s)</h3>\n' "$(escape_html "${NAMES[$i]}")" "$(escape_html "${STATUSES[$i]}")"
        echo "      <pre>"
        while IFS= read -r line; do
          echo "$(escape_html "$line")"
        done < <(tail -n 80 "${LOGS[$i]}")
        echo "      </pre>"
      fi
    done
  fi
  cat <<EOF
    </div>

    <div class="section links">
      <p>상세 체크리스트: <a href="/docs/checklists/MASTER_PROJECT_CHECKLIST.md">docs/checklists/MASTER_PROJECT_CHECKLIST.md</a></p>
      <p>개발 TODO 보드: <a href="/docs/checklists/DEVELOPMENT_TODO_BOARD.md">docs/checklists/DEVELOPMENT_TODO_BOARD.md</a></p>
      <p>운영/장애 대응: <a href="/docs/RUNBOOK.md">docs/RUNBOOK.md</a></p>
      <p>배포 절차: <a href="/docs/DEPLOYMENT.md">docs/DEPLOYMENT.md</a></p>
    </div>
  </div>
</body>
</html>
EOF
} > "$OUTPUT_HTML"

echo "Dashboard generated: $OUTPUT_FILE"
echo "Dashboard generated: $OUTPUT_HTML"

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi

exit 0
