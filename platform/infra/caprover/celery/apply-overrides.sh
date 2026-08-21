#!/usr/bin/env bash
#
# CapRover celery 서비스 오버라이드 적용 (멱등)
# ---------------------------------------------------------------------------
# X99 홈서버의 pickket-celery-beat / pickket-celery-worker 앱에
# serviceUpdateOverride(헬스체크 교정 + stop-first 배포순서)를 적용한다.
#
# 왜: celery 앱은 backend 이미지를 공유하는데, 그 Dockerfile 의 HTTP HEALTHCHECK
#     (curl http://localhost:8000/health/live)를 상속받는다. beat/worker 는
#     HTTP 서버가 없어 항상 fail → swarm 이 죽이고 재생성 반복(flapping) →
#     beat 다중 인스턴스 → 스케줄 중복 발행. 여기서 앱별 헬스체크를 덮어써
#     문제를 없앤다. serviceUpdateOverride 는 CapRover 앱설정에 저장되므로
#     재배포(caprover deploy)에도 유지된다 — 런타임 `--no-healthcheck` 핫픽스와 달리 원복되지 않음.
#
# 사용:
#   CAPROVER_URL=http://192.168.0.9:3000 CAPROVER_PASSWORD='***' \
#     bash apply-overrides.sh
#
# 안전: beat 는 싱글톤이라 stop-first 로 배포순서를 고정(start-first 겹침이
#       stuck-update 원인이었음). beat 먼저, 그다음 worker.
set -euo pipefail

CAP="${CAPROVER_URL:-http://192.168.0.9:3000}"
PW="${CAPROVER_PASSWORD:?CAPROVER_PASSWORD 환경변수 필요}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▶ CapRover 로그인: $CAP"
TOKEN="$(curl -fsS -m 10 -X POST "$CAP/api/v2/login" \
  -H 'Content-Type: application/json' -H 'x-namespace: captain' \
  -d "{\"password\":$(python3 -c 'import json,os;print(json.dumps(os.environ["CAPROVER_PASSWORD"]))')}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')"
[ -n "$TOKEN" ] || { echo "✗ 로그인 실패"; exit 1; }
echo "  ✓ 로그인 OK"

DEFS="$(curl -fsS -m 15 "$CAP/api/v2/user/apps/appDefinitions" \
  -H 'x-namespace: captain' -H "x-captain-auth: $TOKEN")"

apply_one() {
  local app="$1" override_file="$2"
  echo "▶ $app ← $(basename "$override_file")"
  OVERRIDE="$(cat "$override_file")" APP="$app" DEFS="$DEFS" python3 - "$CAP" "$TOKEN" <<'PY'
import json, os, sys, urllib.request

cap, token = sys.argv[1], sys.argv[2]
app = os.environ["APP"]
override = os.environ["OVERRIDE"]
defs = json.loads(os.environ["DEFS"])["data"]["appDefinitions"]
cur = next((a for a in defs if a.get("appName") == app), None)
if not cur:
    print(f"  ✗ 앱 없음: {app}"); sys.exit(1)

# 업데이트 엔드포인트가 읽는 쓰기가능 필드만 현재값 그대로 + serviceUpdateOverride 교체.
override_min = json.dumps(json.loads(override), separators=(",", ":"))
if (cur.get("serviceUpdateOverride") or "").strip() == override_min:
    print("  = 이미 동일 — 건너뜀"); sys.exit(0)

payload = {
    "appName": cur["appName"],
    "instanceCount": cur.get("instanceCount", 1),
    "captainDefinitionRelativeFilePath": cur.get("captainDefinitionRelativeFilePath", "./captain-definition"),
    "notExposeAsWebApp": cur.get("notExposeAsWebApp", True),
    "forceSsl": cur.get("forceSsl", False),
    "websocketSupport": cur.get("websocketSupport", False),
    "containerHttpPort": cur.get("containerHttpPort", 80),
    "description": cur.get("description", ""),
    "envVars": cur.get("envVars", []),
    "ports": cur.get("ports", []),
    "volumes": cur.get("volumes", []),
    "tags": cur.get("tags", []),
    "networks": cur.get("networks", []),
    "customNginxConfig": cur.get("customNginxConfig", ""),
    "preDeployFunction": cur.get("preDeployFunction", ""),
    "redirectDomain": cur.get("redirectDomain", ""),
    "httpAuth": cur.get("httpAuth"),
    "appDeployTokenConfig": cur.get("appDeployTokenConfig", {"enabled": False}),
    "projectId": cur.get("projectId", ""),
    "serviceUpdateOverride": override_min,
}
body = json.dumps(payload).encode()
req = urllib.request.Request(
    f"{cap}/api/v2/user/apps/appDefinitions/update", data=body, method="POST",
    headers={"Content-Type": "application/json", "x-namespace": "captain", "x-captain-auth": token},
)
resp = json.load(urllib.request.urlopen(req, timeout=30))
if resp.get("status") != 100:
    print(f"  ✗ 실패: {resp.get('status')} {resp.get('description')}"); sys.exit(1)
print("  ✓ serviceUpdateOverride 갱신 — 재수렴 트리거됨")
PY
}

apply_one pickket-celery-beat   "$HERE/serviceUpdateOverride.beat.json"
echo "  … beat 재수렴 대기 (10s)"; sleep 10
apply_one pickket-celery-worker "$HERE/serviceUpdateOverride.worker.json"

echo ""
echo "✅ 완료. 검증:"
echo "   docker service ps srv-captain--pickket-celery-beat --no-trunc | head"
echo "   docker service inspect srv-captain--pickket-celery-beat --format '{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck}}'"
