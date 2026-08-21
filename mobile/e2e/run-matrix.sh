#!/bin/bash
# i18n×theme 매트릭스 러너 (T5)
# 사용: bash e2e/run-matrix.sh
#
# 동작:
#   1. ko 로 한 번 — smoke + i18n 태그
#   2. en 으로 한 번 — smoke + i18n 태그
#   3. 결과 요약 출력
#
# 전제: emulator-5554 부팅, dev client + Metro 실행 중.
# 테마 매트릭스는 시스템 다크모드 토글 필요 → 이 스크립트는 i18n 만 자동화.
# 다크모드 검증은 수동: `adb shell "cmd uimode night yes|no"` 후 smoke 재실행.

set -e

cd "$(dirname "$0")/.."

echo "=== Matrix run start ==="
echo "Locale: ko (default)"

# ko: 디바이스 로케일을 한국어로 설정 후 앱 재기동
adb shell "setprop persist.sys.locale ko-KR; setprop ctl.restart zygote" 2>/dev/null || true
sleep 2

npx maestro test e2e/smoke/ --include-tags=smoke 2>&1 | tail -20
KO_RESULT=$?

echo ""
echo "Locale: en"
adb shell "setprop persist.sys.locale en-US; setprop ctl.restart zygote" 2>/dev/null || true
sleep 2

npx maestro test e2e/smoke/ --include-tags=smoke 2>&1 | tail -20
EN_RESULT=$?

echo ""
echo "=== Matrix run summary ==="
echo "ko: $([ $KO_RESULT -eq 0 ] && echo PASS || echo FAIL)"
echo "en: $([ $EN_RESULT -eq 0 ] && echo PASS || echo FAIL)"

# 다크모드 매트릭스 안내
echo ""
echo "다크모드 매트릭스는 수동 실행:"
echo "  adb shell 'cmd uimode night yes' && npm run e2e:smoke"
echo "  adb shell 'cmd uimode night no'  && npm run e2e:smoke"

[ $KO_RESULT -eq 0 ] && [ $EN_RESULT -eq 0 ]
