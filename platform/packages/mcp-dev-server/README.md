# claude-team-sync

> Claude Code를 쓰는 팀이라면 필수 — 세션 간 충돌 없이 협업하세요

여러 명이 Claude Code CLI로 같은 프로젝트를 개발할 때 발생하는 문제를 해결합니다.

- 파일 충돌 자동 감지 (편집 전 경고)
- 팀 작업 현황 실시간 공유
- 세션 간 handoff note 자동화
- Telegram 알림 (블로커, 완료, 충돌)
- GitHub PR ↔ 작업 자동 연결
- 웹 대시보드 실시간 팀 보드

---

## 5분 퀵스타트

```bash
# 1. 서버 실행 (SQLite 기본, 추가 설치 불필요)
cd packages/mcp-dev-server
pip install -r requirements.txt
cp mcp-team.example.yml ../../mcp-team.yml  # .gitignore 처리됨
uvicorn server:app --port 8022

# 2. 팀원 설정 (각자 1회)
bash scripts/mcp-hooks/setup.sh

# 3. Claude Code 재시작 → 자동 연결
```

Docker로 실행:

```bash
docker compose up -d
```

---

## 아키텍처

```
개발자A Claude Code ──┐
개발자B Claude Code ──┼──→ [MCP Dev Server] ←──→ Redis / SQLite
개발자C Claude Code ──┘
                              ↓
                      [Telegram / Slack / Discord]
                              ↓
                      [GitHub Webhook]
                      PR ↔ Task 자동 연결
```

Claude Code의 **Hooks** 기능을 이용해 파일 편집 시 자동으로 충돌 감지 및 락 등록 — 수동 호출 없음.

---

## MCP 툴 목록

Claude 세션에서 직접 호출 가능한 툴:

| 툴                | 설명                                  |
| ----------------- | ------------------------------------- |
| `dev_status`      | 팀 전체 현황 조회 (세션 시작 시 호출) |
| `claim_task`      | 작업 시작 선언 + 파일 등록            |
| `update_progress` | 진행 상황 업데이트                    |
| `complete_task`   | 작업 완료 + handoff note 작성         |
| `check_conflicts` | 파일 충돌 확인                        |
| `post_blocker`    | 블로커 등록 → 팀 알림                 |
| `force_unlock`    | 긴급 락 강제 해제 (이유 기록 필수)    |

---

## Claude Code Hooks 동작

`.claude/settings.json` (레포 루트, 팀 공유)에 등록된 훅이 자동 실행:

| 이벤트         | 훅               | 동작                                             |
| -------------- | ---------------- | ------------------------------------------------ |
| 파일 편집 직전 | `pre-edit.sh`    | 충돌 감지 경고 (서버 다운 시 로컬 캐시 fallback) |
| 파일 편집 직후 | `post-edit.sh`   | 파일 락 자동 등록 (상대경로 정규화)              |
| 세션 종료      | `session-end.sh` | handoff note 작성 프롬프트                       |

---

## 설정 파일 (`mcp-team.yml`)

```yaml
project: my-project
project_root: "/absolute/path/to/project" # setup.sh가 자동 설정

team:
  - name: alice
  - name: bob

storage:
  backend: sqlite # sqlite | redis
  sqlite_path: ".mcp-dev.db"

notifications:
  telegram:
    enabled: true
    # 실제 값은 .env 파일로 분리

  slack:
    enabled: false

github:
  enabled: true
  repo: "owner/repo-name"

lock_mode: soft # soft (경고만) | strict (편집 블로킹)
event_log_ttl_hours: 48
```

> ⚠️ `mcp-team.yml`은 `.gitignore`에 추가하세요. 예시 파일은 `mcp-team.example.yml`.

---

## 환경변수 (`.env`, `.gitignore` 처리)

```env
# MCP 서버
MCP_AUTH_TOKEN=<팀 공유 or 개인 토큰>
MCP_LOCK_MODE=soft

# Telegram (선택)
TELEGRAM_BOT_TOKEN=<BotFather 토큰>
TELEGRAM_CHAT_ID=<팀 그룹 chat_id>

# Slack (선택)
SLACK_WEBHOOK_URL=

# GitHub Webhook (선택)
GITHUB_WEBHOOK_SECRET=<랜덤 시크릿>

# 팀원 개인 설정 (setup.sh가 자동 추가)
PICKKET_DEV_NAME=alice
MCP_SERVER_URL=http://localhost:8022
```

---

## Telegram Bot 셋업

```
1. Telegram → @BotFather → /newbot
2. 봇 이름/username 설정 → 토큰 수령
3. 팀 그룹 생성 → 봇 초대 → 관리자 설정
4. curl "https://api.telegram.org/bot<TOKEN>/getUpdates" → chat_id 확인
5. .env에 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 추가
```

---

## Telegram 알림 예시

```
🚨 블로커 (critical)
개발자: alice
내용: OAuth 콜백 500 에러 — 로그인 전체 막힘

────────────────────
✅ 작업 완료
개발자: alice  |  브랜치: feat/auth
내용: OAuth 플로우 수정 완료
다음: 토큰 갱신 로직 검토
PR: https://github.com/owner/repo/pull/42

────────────────────
⚠️ 파일 충돌
파일: src/middleware.ts
alice (feat/csp) ↔ bob (feat/locale)

────────────────────
🔓 강제 언락
파일: src/middleware.ts
해제: bob  |  사유: alice 오프라인, 긴급 핫픽스
```

---

## REST API

훅 스크립트 및 대시보드에서 사용하는 HTTP API:

```
GET  /api/status            팀 현황 전체
GET  /api/conflicts         파일 충돌 확인 (?files=path1,path2)
POST /api/locks             파일 락 등록
DELETE /api/locks           파일 락 해제
POST /api/tasks             태스크 생성
PATCH /api/tasks/{id}       태스크 업데이트/완료
POST /api/blockers          블로커 등록
GET  /api/tokens            토큰 목록 (관리자)
POST /api/tokens            토큰 발급
DELETE /api/tokens/{token}  토큰 폐기
GET  /events                SSE 스트림 (대시보드용)
POST /webhooks/github       GitHub PR 이벤트
GET  /health                헬스체크
GET  /sse                   MCP SSE 엔드포인트 (Claude용)
POST /messages              MCP 메시지 수신
```

---

## 웹 대시보드

`apps/admin/src/app/dev/` — Next.js Admin 앱에 포함.

```
┌──────────────────────────────────────────────────────────┐
│  Dev Hub  🟢 3명 온라인              [실시간 SSE 자동갱신]│
├──────────────────────────────────────────────────────────┤
│  🚨 BLOCKER: OAuth 500 에러 — alice           [해결됨]   │
├────────────────────┬─────────────────┬───────────────────┤
│ alice              │ bob             │ charlie           │
│ 🟢 feat/auth       │ 🟡 대기중        │ 🔵 PR 리뷰 중     │
│ 3개 파일 수정 중    │                 │ PR #42 ↗          │
│ 2시간 전 시작       │                 │ 완료 30분 전       │
├────────────────────┴─────────────────┴───────────────────┤
│  📂 잠긴 파일                                            │
│  src/middleware.ts ──────── alice  (feat/auth)           │
│  backend/app/core/database.py ── alice  (feat/auth)      │
├──────────────────────────────────────────────────────────┤
│  📋 최근 핸드오프                                        │
│  charlie · 35분 전  mobile auth 완료. 다음: push 알림    │
├──────────────────────────────────────────────────────────┤
│  📈 타임라인 (최근 24h)                    [48h 보기]    │
│  alice   ████░░░░░░  │  bob  ░░████░░░░  │  ...         │
└──────────────────────────────────────────────────────────┘
```

---

## 오프라인 내성

서버가 다운되어도 개발이 멈추지 않습니다:

1. `pre-edit.sh` 서버 호출 실패 시 → `.mcp-cache.json` 로컬 파일 확인
2. `post-edit.sh` 실패 시 → 변경 내용 `.mcp-cache.json`에 큐잉
3. 서버 재연결 시 → 캐시 자동 sync

---

## Lock 모드

| 모드          | 동작                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| `soft` (기본) | 충돌 시 경고 출력, 편집 계속 가능                                             |
| `strict`      | 충돌 시 편집 블로킹 (exit 1), `force_unlock` 또는 원 소유자 완료 후 편집 가능 |

---

## 보안

- Bearer 토큰 인증 (`MCP_AUTH_TOKEN`)
- 관리자 API (`/api/tokens`)는 `X-Admin-Key` 헤더 별도 인증
- `force_unlock` 실행 시 사유 + 요청자 로그 + Telegram 알림 필수 기록
- `.env`, `mcp-team.yml`, `.mcp-cache.json` 반드시 `.gitignore` 처리

---

## 저장소 백엔드

| 백엔드 | 추천 환경           | 설정                        |
| ------ | ------------------- | --------------------------- |
| SQLite | 팀 1-3명, 단일 서버 | `backend: sqlite`           |
| Redis  | 프로덕션, 분산 환경 | `backend: redis` (TLS 지원) |

---

## 기여

Issues, PRs 환영합니다.

---

## 라이선스

MIT
