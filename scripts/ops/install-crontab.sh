#!/usr/bin/env bash
# PICKKET 운영 crontab 등록 — 멱등(마커 블록 교체). 블록 밖 무관한 크론은 보존한다.
#
# ═══════════════════════════════════════════════════════════════════════════
# 2026-07-29 전면 수정 — 이 스크립트는 **운영 실태를 재현하지 못하는 상태**였다
# ═══════════════════════════════════════════════════════════════════════════
#
# 발견(통합DB 감사 3회차): 실제 호스트 crontab 에는 크론 7개가 돌고 있는데
# 이 스크립트는 활성 1줄(dispatch-invitations)뿐이었다. 그래서 스크립트만 읽은
# 사람은 "크론이 안 돈다" 고 오판한다(실제로 감사 중 그 오판이 나왔다).
#
# 🔴 더 중요한 것 — 단순히 낡은 게 아니라 **실행하면 깨지는 구조**였다:
#
#   crontab 의 환경변수 대입은 **그 아래 줄에만** 적용된다.
#   그런데 CRON_SECRET 대입이 마커 블록 **바깥(아래)** 에 있었고,
#   유일한 활성 크론은 블록 **안(위)** 에 있었다.
#     ⟹ 그 줄은 `Authorization: Bearer ` (빈 토큰) 로 발사된다 → **401**
#     ⟹ `-fsS … >/dev/null 2>&1` 이 오류를 통째로 삼킨다 → **아무도 모른다**
#
#   2026-07-28 에 누군가 이 함정을 발견하고 실제 크론들을 CRON_SECRET 아래로
#   손수 옮겨 살렸다. 그 수정이 스크립트에는 반영되지 않아 괴리가 생겼다.
#
#   ⚠️ 결정적 위험은 **재해복구**다. 빈 crontab 에서 이 스크립트를 실행하면
#      CRON_SECRET 대입이 없으므로 **전 크론이 조용히 401** 이고, 나머지 6개는
#      아예 없다. "설치 완료" 메시지만 보고 정상이라 믿게 된다.
#
# 수정 내용:
#   1. 운영 중인 크론 7개를 전부 스크립트에 반영(활성)
#   2. **CRON_SECRET 대입을 블록 안 맨 앞으로** — 순서 의존을 구조로 보장
#   3. 시크릿이 없으면 **설치를 거부**한다(조용히 깨진 걸 심지 않는다)
#   4. 블록 밖에 흩어진 레거시 크론 줄을 흡수(중복 방지)
#   5. `--check` — 실제 crontab 과 대조만 하고 아무것도 바꾸지 않는다
#
# ⚠️ "스케줄 정본 = organizer/infra/cron/*.yaml(k8s)" 이라는 옛 서술은 폐기한다.
#    k8s 클러스터는 존재하지 않는다. **정본은 이 스크립트다**(PLATFORM-CRON-RECONCILIATION.md).
#
# 사용법:
#   bash install-crontab.sh --check     # 대조만(안전, 변경 없음)
#   CRON_SECRET=... bash install-crontab.sh   # 설치
#   bash install-crontab.sh             # 설치(기존 crontab 의 CRON_SECRET 재사용)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="/home/oem/Development/active/pickket-v3"
GO="https://go.pickket.kr/api/cron"
BEGIN="# >>> pickket-ops >>>"
END="# <<< pickket-ops <<<"
MODE="${1:-install}"

current=$(crontab -l 2>/dev/null || true)

# ── 시크릿 확보 — 값을 **출력하지 않는다**(프로세스 목록·로그 노출 방지) ──────
# 우선순위: 환경변수 > 기존 crontab 의 대입줄. 둘 다 없으면 설치 거부.
secret="${CRON_SECRET:-}"
if [ -z "$secret" ]; then
  secret=$(printf '%s\n' "$current" | sed -nE 's/^[[:space:]]*CRON_SECRET=(.*)$/\1/p' | head -1)
fi

if [ "$MODE" != "--check" ] && [ -z "$secret" ]; then
  cat >&2 <<'MSG'
✗ 설치 거부 — CRON_SECRET 을 찾지 못했습니다.

  이대로 설치하면 모든 크론이 빈 토큰으로 발사돼 401 이 되고,
  그 실패는 `>/dev/null 2>&1` 에 삼켜져 **아무도 모릅니다.**
  "설치 완료" 만 보고 정상이라 믿게 되는 것이 이 스크립트의 과거 결함이었습니다.

  해결: CRON_SECRET=... bash scripts/ops/install-crontab.sh
        (값은 CapRover 의 organizer 앱 환경변수와 같아야 합니다)
MSG
  exit 1
fi

# ── 원하는 상태(desired) ────────────────────────────────────────────────────
# 🔴 CRON_SECRET 대입이 **블록 맨 앞**에 있어야 아래 curl 들이 토큰을 받는다.
#    이 순서가 이 파일의 존재 이유다 — 바꾸지 말 것.
BLOCK=$(cat <<CRON
$BEGIN
# ── 머신층 감시 (docs/OPS_ORCHESTRATION_PLAN.md §2.2) — 세션 무관 ──
*/5 * * * *  $REPO/scripts/ops/sentinel.sh
3 9 * * *    $REPO/scripts/ops/backup-check.sh
# prod DB 백업(P0-B) → 워크스테이션 HDD. 활성 2026-07-20(대표 승인).
10 3 * * *   $REPO/scripts/ops/backup-db.sh

# ── go(organizer) HTTP 크론 ── UTC 기준 실행 ──
# 🔴 아래 대입은 반드시 curl 들보다 **위**에 있어야 한다(crontab 변수는 아래 줄에만 적용).
CRON_SECRET=$secret

# 매분 — 큐 드레인
# 초대권 발송 + 도달 대사. 없으면 「대량 초대」가 대기열에만 쌓이고 알림톡이
# 영영 안 나간다(화면엔 발권 완료로 보여 아무도 모른다).
* * * * *    curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/dispatch-invitations >/dev/null 2>&1
* * * * *    curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/drain-audit-outbox >/dev/null 2>&1
* * * * *    curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/drain-waitlist-recovery >/dev/null 2>&1
* * * * *    curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/retry-order-webhooks >/dev/null 2>&1

# 5분
*/5 * * * *  curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/payment-reconcile >/dev/null 2>&1
# ⚠️ expire-orders 는 7개 중 **유일하게 ops_cron_runs 기록을 남기지 않는다**
#    (라우트에 startCronRun 미호출). 돌고 있는지 멈췄는지 확인할 방법이 없다 — 계측 추가 대상.
*/5 * * * *  curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/expire-orders >/dev/null 2>&1

# 일 1회 (UTC)
15 0 * * *   curl -fsS -m 55 -H "Authorization: Bearer \$CRON_SECRET" $GO/ops-cleanup >/dev/null 2>&1

# ── 미투입(주기·필요성 미확정). 켜기 전 담당자 확인 필요 ──
# * * * * *    … $GO/dispatch-messages      # 메시징 배포 후
# * * * * *    … $GO/dispatch-campaigns     # 메시징 배포 후
# */5 * * * *  … $GO/reconcile-deliveries   # 발송 도달 대사(초대권은 dispatch-invitations 가 겸함)
# 0 0 * * *    … $GO/reminders
# */5 * * * *  … $GO/seat-watch-trigger     # 좌석홀드 만료 감시
# */5 * * * *  … $GO/agent-tasks            # 목적 확인 필요
# 30 0 * * *   … $GO/consent-reconfirm      # 동의 2년 재확인
$END
CRON
)

# ── 대조 모드 ───────────────────────────────────────────────────────────────
if [ "$MODE" = "--check" ]; then
  # 활성 크론 줄 → "이름<TAB>스케줄" 로 정규화. 시크릿은 절대 출력하지 않는다.
  norm() {
    grep -E "^[^#]*$GO/" \
      | sed -E "s#^([^c]*[0-9*/, -]+)[[:space:]]+curl.*$GO/([a-z-]+).*#\2\t\1#" \
      | sed -E 's/[[:space:]]+$//' | sort
  }
  printf '%s\n' "$current" | norm > /tmp/.cron_live
  printf '%s\n' "$BLOCK"   | norm > /tmp/.cron_want

  echo "── 이름 · 스케줄 대조 (좌=실제, 우=이 스크립트) ──"
  if diff -y --width=76 /tmp/.cron_live /tmp/.cron_want; then
    echo
    echo "  ✅ **완전 일치** — 스크립트가 운영 실태를 그대로 재현한다"
  else
    echo
    echo "  ⚠️ 차이 있음 — 위 표에서 < > | 표시된 줄 확인"
  fi
  rm -f /tmp/.cron_live /tmp/.cron_want
  exit 0
fi

# ── 설치 ────────────────────────────────────────────────────────────────────
# 제거 대상: ①옛 마커 블록 전체 ②블록 밖에 흩어진 go 크론 줄 ③중복 CRON_SECRET 대입
# (①만 지우던 옛 동작은 ②를 남겨 **중복 등록**을 만들었다)
cleaned=$(printf '%s\n' "$current" \
  | awk -v b="$BEGIN" -v e="$END" 'index($0,b){s=1} !s{print} index($0,e){s=0}' \
  | grep -vE "$GO/" \
  | grep -vE "^[[:space:]]*CRON_SECRET=" \
  | grep -vE "^[[:space:]]*#.*(레벨2 drain/reconcile|초대권 발송 큐 드레인|알림톡이 영영|대표 승인 후 추가|판매 전 필수|CRON_SECRET 정의 이후)" \
  | sed '/^[[:space:]]*$/d')

printf '%s\n\n%s\n' "$cleaned" "$BLOCK" | crontab -

echo "등록 완료 — go 크론 $(crontab -l | grep -cE "^[^#]*$GO/") 개 활성"
echo "확인: crontab -l   ·   실행기록: ops_cron_runs 테이블"
