#!/usr/bin/env bash
# PICKKET CapRover 배포 — 커밋된 HEAD 기준 타르볼 업로드 (runbooks/routine-배포.md 의 스크립트화)
# 사용: scripts/ops/deploy-app.sh <organizer|consumer|backend|admin>
# 가드레일: 관문(qa·security) 통과 + 대표 확인 프롬프트. working tree 배포 불가(HEAD 아카이브).
set -euo pipefail

# 🔴 2026-07-31 실사고 — REPO 가 `/home/oem/.../pickket-v3` 로 **하드코딩**돼 있었다.
#    이 스크립트를 배포 워크트리(pickket-v3-tiercap)에서 돌려도 `cd` 한 순간 다른
#    워크트리로 옮겨가고, `DEPLOY_REF` 를 안 붙이면 `HEAD` 가 **그쪽 브랜치(main)** 로 잡힌다.
#    main 은 배포본과 별개 계보라 그날 작업(시간대·환불정책·초대권·인증)이 통째로 빠진
#    이미지가 prod 에 떴다. 그날 24번은 DEPLOY_REF 를 붙여 통과했고 25번째에 놓쳤다 —
#    "매번 기억한다" 는 방어가 아니다.
#
# ⟹ 이제 **이 스크립트가 있는 워크트리**를 배포 원본으로 삼는다. 실행한 곳이 배포되는 곳이다.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 운영 설정(ops.env)은 워크트리마다 두지 않는다 — 한 곳을 공유한다.
# (없어도 동작해야 하므로 아래 `[ -f ]` 가드는 유지)
OPS_HOME="${OPS_HOME:-/home/oem/Development/active/pickket-v3}"
OPS_ENV="$OPS_HOME/scripts/ops/ops.env"
[ -f "$OPS_ENV" ] && . "$OPS_ENV"
CAP="${CAPROVER_URL:-http://192.168.0.9:3000}"

APP_KEY="${1:-}"
case "$APP_KEY" in
  organizer) CAP_APP="pickket-organizer"; SRC="organizer"; CAPDEF="" ;;
  consumer)  CAP_APP="pickket-consumer";  SRC="platform"; CAPDEF='{"schemaVersion":2,"dockerfilePath":"./apps/consumer/Dockerfile"}' ;;
  backend)   CAP_APP="pickket-backend";   SRC="platform"; CAPDEF='{"schemaVersion":2,"dockerfilePath":"./backend/Dockerfile"}' ;;
  admin)     CAP_APP="pickket-admin";     SRC="platform"; CAPDEF='{"schemaVersion":2,"dockerfilePath":"./apps/admin/Dockerfile"}' ;;
  *) echo "사용: $0 <organizer|consumer|backend|admin>"; exit 1 ;;
esac

cd "$REPO"

# 배포 ref — 기본 HEAD. **다른 브랜치/워크트리의 커밋을 배포할 때 DEPLOY_REF 로 지정**한다.
#   예) DEPLOY_REF=e1cc4bfa bash scripts/ops/deploy-app.sh organizer
#
# 🔴 이 기능이 없으면 "실행한 워크트리의 HEAD" 만 나간다. 세션이 여럿이고 배포본 브랜치가
#    main 과 별개 계보인 지금 구조에서는, 배포하려는 해시가 실행 워크트리에 없는 게 정상이다
#    (실제로 2026-07-29 배포 6건이 전부 DEPLOY_REF 로 나갔다).
REF="${DEPLOY_REF:-HEAD}"
if ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  echo "❌ DEPLOY_REF='$REF' 를 찾을 수 없습니다."; exit 1
fi
# 🔴 아카이브 대상과 **같은 ref** 의 sha 를 쓴다. HEAD sha 를 쓰면 이미지에 심기는 커밋과
#    실제 배포된 코드가 어긋나 `build.commit` 이 **거짓을 말한다** — 없느니만 못하다.
HEAD_SHA=$(git rev-parse --short "$REF")
if [ "$REF" = "HEAD" ] && ! git diff --quiet -- "$SRC" 2>/dev/null; then
  echo "⚠️  $SRC 에 커밋 안 된 변경이 있습니다. HEAD($HEAD_SHA) 기준으로 배포됩니다 — 의도 확인 필요."
fi

# 🔴 **무엇이 나가는지 눈에 보이게 한다.** 2026-07-31 사고 때 화면에 뜬 것은
#    "배포 대상: pickket-organizer ← HEAD 5ff718a5 (organizer)" 였다. 해시만 봐서는
#    그게 main 인지 배포브랜치인지 알 수 없었다 — 브랜치와 워크트리를 같이 찍으면 보인다.
# 🔴 `git rev-parse --abbrev-ref <해시>` 는 **빈 문자열을 성공(0)으로** 돌려준다
#    (2026-07-31 코덱스 감사 · 실제 9a87d1cd 로 재현). `|| echo "?"` 는 종료코드만 보므로
#    안 걸리고, 배너에 브랜치가 **공란**으로 찍힌다 — DEPLOY_REF 를 쓰는 배포가 정확히
#    그 경우라, 정작 필요할 때 정보가 사라진다.
#    ⟹ 그 해시를 **포함하는 브랜치**를 찾아 보여준다. 없으면 "(어느 브랜치에도 없음)" —
#      그것 자체가 위험 신호다(떠 있는 커밋을 배포하려는 것).
BRANCH=$(git rev-parse --abbrev-ref "$REF" 2>/dev/null || true)
[ "$BRANCH" = "HEAD" ] && BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [ -z "$BRANCH" ]; then
  BRANCH=$(git branch --contains "$REF" --format='%(refname:short)' 2>/dev/null | paste -sd, -)
  [ -n "$BRANCH" ] && BRANCH="$BRANCH (해시 지정)" || BRANCH="🔴 어느 브랜치에도 없음"
fi
echo "=== 배포 대상: $CAP_APP ← $REF $HEAD_SHA ($SRC) ==="
echo "    워크트리: $REPO"
echo "    브랜치  : $BRANCH"
echo "    커밋    : $(git log -1 --format='%s' "$REF" 2>/dev/null | cut -c1-70)"
echo "관문 확인 — qa(tsc/vitest) 및 security-reviewer 통과했습니까?"
read -r -p "확인했으면 앱 이름($APP_KEY)을 그대로 입력: " CONFIRM
[ "$CONFIRM" = "$APP_KEY" ] || { echo "중단."; exit 1; }

# 비번: env → 시크릿파일 → 프롬프트
PASS="${CAPROVER_PASSWORD:-}"
if [ -z "$PASS" ] && [ -f "$HOME/Desktop/pickket-caprover-secrets.env" ]; then
  PASS=$(grep -m1 '^CAPROVER_PASSWORD=' "$HOME/Desktop/pickket-caprover-secrets.env" | cut -d= -f2- || true)
fi
[ -z "$PASS" ] && read -r -s -p "CapRover 비밀번호: " PASS && echo

TOKEN=$(curl -fsS -X POST "$CAP/api/v2/login" -H 'Content-Type: application/json' \
  -H 'x-namespace: captain' -d "{\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')

TAR="/tmp/deploy-$APP_KEY-$HEAD_SHA.tar"
git archive --format=tar -o "$TAR" "$REF:$SRC"
if [ -n "$CAPDEF" ]; then
  ( cd /tmp && printf '%s' "$CAPDEF" > captain-definition && tar --append -f "$TAR" captain-definition && rm -f captain-definition )
fi

# 🔴 배포 커밋을 **이미지 안에** 심는다 (회신 #25 §3 대응).
#
# CapRover 는 타르볼 배포라 `gitHash` 를 공란으로 둔다. 그래서 "prod 에 지금 무엇이
# 돌고 있나" 를 아무도 알 수 없고, 2026-07-29 에 실제로 양쪽 세션이 서로의 배포를
# 오인했다(한쪽은 "내 커밋이 배포됐다" 고 오판, 다른 쪽은 "멈춘 빌드" 로 오판).
# 동작 탐침으로 역추적하는 방식은 매번 비용이고 그날 실제로 틀렸다.
#
# 로그 파일은 **배포 의도**를 남기지만, 이 파일은 **실제 돌고 있는 것**을 남긴다.
# 둘 중 진실은 후자다 — 롤백·수동 재배포·빌드 실패 후에도 이 값은 이미지를 따라간다.
( cd /tmp && printf '{"commit":"%s","app":"%s","builtAt":"%s"}' \
    "$HEAD_SHA" "$CAP_APP" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .build-info.json \
  && tar --append -f "$TAR" .build-info.json && rm -f .build-info.json )

echo "업로드 중..."
curl -fsS -X POST "$CAP/api/v2/user/apps/appData/$CAP_APP?detached=1" \
  -H 'x-namespace: captain' -H "x-captain-auth: $TOKEN" -F "sourceFile=@$TAR" >/dev/null

echo "빌드 감시 (12~18분 소요 가능)..."
for i in $(seq 1 120); do
  sleep 15
  ST=$(curl -fsS "$CAP/api/v2/user/apps/appData/$CAP_APP" -H 'x-namespace: captain' -H "x-captain-auth: $TOKEN")
  BUILDING=$(echo "$ST" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("isAppBuilding"))')
  FAILED=$(echo "$ST" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("isBuildFailed"))')
  if [ "$FAILED" = "True" ]; then echo "❌ 빌드 실패 — CapRover 로그 확인"; exit 1; fi
  if [ "$BUILDING" = "False" ]; then echo "✅ 빌드 완료 ($((i*15))초)"; break; fi
  echo "  ...빌드 중 ($((i*15))초)"
done

# 🔴 헬스 검증 — **컨테이너 교체를 기다린 뒤** 판정한다 (2026-07-29 → 07-30 개선).
#
# ── 1차 사고(07-29): 실패를 실패로 안 끝냈다 ──
# 종전 코드는 `curl -fsS ... && echo " ← ready"` 였다. `A && B` 형태에서는 A 가 실패해도
# `set -e` 가 트리거되지 않는다(A 가 리스트의 마지막 명령이 아니라 면제된다).
# 헬스가 503 인데도 "완료" 를 출력하고 exit 0 으로 끝났고, 서비스는 25분간 502 였다.
#
# ── 2차 사고(07-30): 정상 배포를 실패로 오판했다 ──
# 1차를 고치면서 "빌드 직후 **한 번** 찍고 실패면 exit 1" 로 만들었다. 그런데 CapRover 는
# 빌드 완료 후 컨테이너를 **교체**하고, 그 사이 수십 초간 502/503 이 정상적으로 난다.
# 그래서 정상 배포에도 실패 안내가 떴다. **거짓 양성을 내는 장치는 곧 무시된다.**
#
# ⟹ 교체가 끝날 때까지 기다린다. 그리고 organizer 는 200 만 보지 않고
#    **`build.commit` 이 방금 배포한 해시와 일치**하는지까지 본다 —
#    200 이어도 옛 컨테이너가 응답하는 중이면 "배포됐다" 가 거짓이다.
# 테스트에서 짧게 덮어쓸 수 있게 둔다 — 로직을 실배포 없이 검증하기 위해서다.
HEALTH_TRIES="${HEALTH_TRIES:-10}"          # 30초 × 10 = 최대 5분
HEALTH_INTERVAL="${HEALTH_INTERVAL:-30}"
UA="Mozilla/5.0 (X11; Linux x86_64)"

case "$APP_KEY" in
  organizer) HEALTH_URL="https://go.pickket.kr/api/health/ready"; EXPECT_COMMIT="$HEAD_SHA" ;;
  backend)   HEALTH_URL="https://api.pickket.kr/health/ready";    EXPECT_COMMIT="" ;;
  consumer)  HEALTH_URL="https://www.pickket.kr/";                EXPECT_COMMIT="" ;;
  admin)     HEALTH_URL="https://admin.pickket.kr/";              EXPECT_COMMIT="" ;;
  *)         HEALTH_URL=""; EXPECT_COMMIT="" ;;
esac

HEALTH_OK=0
LAST_SEEN="(응답 없음)"
if [ -n "$HEALTH_URL" ]; then
  echo "헬스 검증 (컨테이너 교체 대기, 최대 $((HEALTH_TRIES * HEALTH_INTERVAL))초):"
  for i in $(seq 1 "$HEALTH_TRIES"); do
    BODY=$(curl -fsS -m 15 -A "$UA" "$HEALTH_URL" 2>/dev/null || true)
    if [ -n "$BODY" ]; then
      if [ -z "$EXPECT_COMMIT" ]; then
        HEALTH_OK=1; LAST_SEEN="응답 OK"; break
      fi
      GOT=$(printf '%s' "$BODY" | grep -o '"commit":"[^"]*"' | cut -d'"' -f4 || true)
      LAST_SEEN="commit=${GOT:-unknown}"
      if [ "$GOT" = "$EXPECT_COMMIT" ]; then HEALTH_OK=1; break; fi
    fi
    echo "  ...대기 ($((i * HEALTH_INTERVAL))초) — $LAST_SEEN"
    sleep "$HEALTH_INTERVAL"
  done
else
  HEALTH_OK=1
fi

if [ "$HEALTH_OK" = "1" ]; then
  echo "✅ 헬스 정상 — $LAST_SEEN"
else
  echo ""
  echo "🔴 $((HEALTH_TRIES * HEALTH_INTERVAL))초 동안 헬스가 정상화되지 않았습니다 — 마지막 관측: $LAST_SEEN"
  echo ""
  echo "   먼저 확인할 것 (07-29 사고 원인 순서):"
  echo "   1) 서버 디스크:  ssh <서버> 'df -h /; docker system df'"
  echo "      가득 찼으면:  docker image prune -a -f   (⚠️ --volumes 금지 — DB 가 날아간다)"
  echo "   2) 컨테이너 로그: CapRover 대시보드 → $CAP_APP → App Logs"
  echo "   3) 회복 확인:    curl -s $HEALTH_URL"
  echo ""
  echo "   ⚠️ 롤백해도 디스크 문제는 안 고쳐집니다 — 같은 자리에서 다시 죽습니다."
  echo "   ⚠️ commit 이 옛 해시로 고정돼 있으면 새 컨테이너가 뜨지 못한 것입니다."
  exit 1
fi

# backend 배포는 celery-beat/worker 도 같은 이미지를 재배포한다 → Dockerfile 의 HTTP HEALTHCHECK 를
# celery 가 상속받아 crash-loop(예약작업 중복발행=결제 이중처리 위험). serviceUpdateOverride 로 교정.
# CapRover 앱설정에 저장돼 재배포에도 유지되지만, "적용"은 매 backend 배포 후 멱등 재실행이 안전.
if [ "$APP_KEY" = "backend" ]; then
  echo "▶ celery 헬스체크 오버라이드 적용(apply-overrides.sh)..."
  if CAPROVER_URL="$CAP" CAPROVER_PASSWORD="$PASS" \
       bash "$REPO/platform/infra/caprover/celery/apply-overrides.sh"; then
    echo "✅ celery 오버라이드 적용 완료(beat=NONE, worker=inspect ping, stop-first)"
  else
    echo "⚠️ celery 오버라이드 적용 실패 — 수동 실행 필요:"
    echo "   CAPROVER_PASSWORD=... bash platform/infra/caprover/celery/apply-overrides.sh"
    echo "   (미적용 시 celery crash-loop=예약작업 중복발행 위험)"
  fi
fi

# 🔴 배포 이력 자동 기록 (회신 #25 §3 제안 A). 사람 규율이 아니라 도구가 남긴다.
#    ⚠️ 이건 **의도**의 기록이다. 실제 돌고 있는 것은 헬스 응답의 build.commit 이
#    말한다(이미지에 심어둔 표식). 둘이 어긋나면 후자가 진실이다 — 롤백·수동
#    재배포 후 이 로그만 보면 또 오인한다.
DEPLOY_LOG="$REPO/docs/ops/DEPLOY-LOG.md"
if [ -f "$DEPLOY_LOG" ]; then
  printf '| %s | %s | `%s` | %s |\n' \
    "$(date -u +%Y-%m-%dT%H:%MZ)" "$CAP_APP" "$HEAD_SHA" "${DEPLOY_ACTOR:-$(whoami)}" >> "$DEPLOY_LOG"
  echo "📝 $DEPLOY_LOG 에 기록했습니다(커밋 필요)."
fi

echo "완료. 커밋 $HEAD_SHA. 15분간 sentinel/로그 관찰 권장."
echo "   실행 중인 커밋 확인: curl -s https://go.pickket.kr/api/health/ready | grep -o '\"commit\":\"[^\"]*\"'"
