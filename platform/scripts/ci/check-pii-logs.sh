#!/bin/bash
# PII 로그 누출 린트: logger.* 호출이 email/phone/resident_number를 평문 전달하지 않도록 검사.
# 허용: mask_email(...) / mask_phone(...) / mask_resident_number(...) 로 감싼 경우.
#
# 위반 패턴 예시:
#   logger.info("...", user.email)                        — 평문 email
#   logger.warning("phone=%s", data.phone)                — 평문 phone
# 허용 패턴:
#   logger.info("...", mask_email(user.email))
#   logger.info("...", mask_phone(data.phone))

set -euo pipefail

EXIT_CODE=0

echo "=== PII Logs Lint (backend) ==="

# logger.X("pattern", ...Y.email...) without mask_email(
# logger.X("pattern", ...Y.phone...) without mask_phone(
# Multi-line arg detection skipped — we scan single-line calls.
VIOLATIONS=$(grep -rnE 'logger\.(info|debug|warning|error|critical)\(.*\.(email|phone|resident_number)[^_a-zA-Z]' \
  backend/app/ 2>/dev/null \
  | grep -v '__pycache__' \
  | grep -v 'mask_email' \
  | grep -v 'mask_phone' \
  | grep -v 'mask_resident_number' \
  | grep -v 'test_' \
  | grep -v '\.pyc' \
  | grep -v '# allow-pii' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: PII leaked to logger (wrap with mask_email / mask_phone / mask_resident_number):"
  echo "$VIOLATIONS"
  EXIT_CODE=1
else
  echo "PASS: No PII leaked to logger.*"
fi

exit $EXIT_CODE
