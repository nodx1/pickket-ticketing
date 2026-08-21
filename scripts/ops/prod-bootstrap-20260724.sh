#!/usr/bin/env bash
# prod 부트스트랩(super_admin + 기본 fee)만 재실행 — DROP+마이그는 이미 완료.
# prod backend 의 실 CapRover env(PII_ENCRYPTION_KEY 등)를 그대로 써서 backend 와 일치시킴.
# 실행:  ADMIN_PASSWORD='...' bash scripts/ops/prod-bootstrap-20260724.sh
set -euo pipefail

REPO=/home/oem/Development/active/pickket-v3
cd "$REPO"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD 를 env로 전달: ADMIN_PASSWORD='...' bash $0}"

# host-접근 DB URL (192.168.0.9:15432)
set -a; source scripts/ops/backup.env; set +a
: "${PG_V2_URL:?PG_V2_URL 미설정}"

# CapRover 에서 pickket-backend 실 env 추출 → 임시 env 파일(600)
CAP="http://192.168.0.9:3000"
PASS=$(grep -m1 '^CAPROVER_PASSWORD=' "$HOME/Desktop/pickket-caprover-secrets.env" | cut -d= -f2-)
TOKEN=$(curl -fsS -m 15 -X POST "$CAP/api/v2/login" -H 'Content-Type: application/json' -H 'x-namespace: captain' -d "{\"password\":\"$PASS\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")

TMPJSON=$(mktemp); TMPENV=$(mktemp); chmod 600 "$TMPENV"
trap 'rm -f "$TMPJSON" "$TMPENV"' EXIT
curl -fsS -m 20 "$CAP/api/v2/user/apps/appDefinitions" -H 'x-namespace: captain' -H "x-captain-auth: $TOKEN" -o "$TMPJSON"

python3 - "$TMPJSON" "$TMPENV" <<'PY'
import sys, json
data = json.load(open(sys.argv[1]))
out = sys.argv[2]
apps = data["data"]["appDefinitions"]
app = next(a for a in apps if a["appName"] == "pickket-backend")
with open(out, "w") as f:
    for e in app.get("envVars", []):
        k = e["key"]; v = str(e.get("value", ""))
        vq = v.replace("'", "'\\''")
        f.write(f"export {k}='{vq}'\n")
print(f"  prod backend env {len(app.get('envVars',[]))}개 로드")
PY

# 실 prod 시크릿 로드 → DB URL 만 host-접근용으로 오버라이드(내부 호스트명 회피)
set -a; source "$TMPENV"; set +a
export DATABASE_URL="postgresql+asyncpg://${PG_V2_URL#postgresql://}"
export ADMIN_EMAIL="admin@pickket.kr"

echo "  ENVIRONMENT=${ENVIRONMENT:-?}  DB=host(15432)  admin=$ADMIN_EMAIL"
cd "$REPO/platform/backend"
.venv/bin/python scripts/seed_bootstrap.py

echo ""
echo "== 검증 =="
psql "$PG_V2_URL" -c "SELECT (SELECT version_num FROM alembic_version) AS head, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM users WHERE is_admin) AS admins, (SELECT count(*) FROM fee_schedules) AS fees;"
echo "== ✅ 부트스트랩 완료 =="
