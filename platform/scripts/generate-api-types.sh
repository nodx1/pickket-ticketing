#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# generate-api-types.sh — OpenAPI 스키마에서 TypeScript 타입 자동 생성
#
# 사용법:
#   bash scripts/generate-api-types.sh                      # 기본 (localhost:8001)
#   API_URL=https://api.pickket.kr bash scripts/generate-api-types.sh
#
# 사전 조건:
#   - Backend API 서버가 실행 중이어야 합니다 (개발/스테이징 환경)
#   - 프로덕션 환경에서는 OpenAPI 스키마가 비활성화됩니다
#   - npx (Node.js 18+) 필요
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCHEMA_URL="${API_URL:-http://localhost:8001}/openapi.json"
OUTPUT_DIR="packages/lib/src/generated"
SCHEMA_FILE="/tmp/pickket-openapi.json"

echo "==> OpenAPI 스키마 다운로드: ${SCHEMA_URL}"
HTTP_CODE=$(curl -s -o "$SCHEMA_FILE" -w "%{http_code}" "$SCHEMA_URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: OpenAPI 스키마를 가져올 수 없습니다 (HTTP ${HTTP_CODE})"
  echo "  - Backend API가 실행 중인지 확인하세요"
  echo "  - 프로덕션 환경에서는 OpenAPI가 비활성화됩니다"
  exit 1
fi

# Validate JSON
if ! python3 -c "import json; json.load(open('$SCHEMA_FILE'))" 2>/dev/null; then
  echo "ERROR: 유효하지 않은 JSON 응답입니다"
  exit 1
fi

echo "==> 출력 디렉토리 생성: ${OUTPUT_DIR}"
mkdir -p "$OUTPUT_DIR"

echo "==> TypeScript 타입 생성 중..."
npx openapi-typescript "$SCHEMA_FILE" -o "${OUTPUT_DIR}/api-types.ts"

# Add header comment
TEMP_FILE=$(mktemp)
cat > "$TEMP_FILE" <<'HEADER'
/**
 * Auto-generated TypeScript types from OpenAPI schema.
 * DO NOT EDIT manually — run `bash scripts/generate-api-types.sh` to regenerate.
 *
 * @generated
 */
HEADER
cat "${OUTPUT_DIR}/api-types.ts" >> "$TEMP_FILE"
mv "$TEMP_FILE" "${OUTPUT_DIR}/api-types.ts"

echo "==> 완료! 생성된 파일: ${OUTPUT_DIR}/api-types.ts"
echo "    스키마 버전: $(python3 -c "import json; d=json.load(open('$SCHEMA_FILE')); print(d.get('info',{}).get('version','unknown'))" 2>/dev/null || echo 'unknown')"

# Clean up temp file
rm -f "$SCHEMA_FILE"
