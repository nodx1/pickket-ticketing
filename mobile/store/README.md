# Store Metadata & Screenshots

스토어 제출 전 이 디렉터리를 채우세요.

## 구조

```
store/
  metadata/
    ko/                     # 한국어 메타데이터
      title.txt             # 앱 타이틀 (30자)
      subtitle.txt          # 서브타이틀 (30자, iOS)
      keywords.txt          # 쉼표 구분 키워드 (100자, iOS)
      promo_text.txt        # 프로모션 텍스트 (170자, iOS)
      description.txt       # 앱 설명 (4000자)
    en/                     # 영어 메타데이터 (동일 구조)
  screenshots/
    ios-67/                 # iPhone 6.7" (iPhone 15 Pro Max 등)  1290×2796
    ios-61/                 # iPhone 6.1" (iPhone 15/15 Pro)      1179×2556
    ios-55/                 # iPhone 5.5" (iPhone 8 Plus)          1242×2208 (레거시)
    ipad-129/               # iPad Pro 12.9"                       2048×2732
    android-phone/          # Android phone 16:9 또는 9:16        1080×1920 이상
    android-tablet/         # Android tablet                      1200×1920 이상
```

## 권장 스크린샷 5컷

각 디바이스 사이즈마다 아래 5컷을 준비:
1. **Discover 탭** — 풀스크린 수직 피드 (핵심 차별화)
2. **AI 컨시어지** — 대화 UI + refinement chips
3. **이벤트 상세** — 포스터 + 가격 + "Book Now"
4. **D-day 카운트다운 / QR 티켓** — 결제 후 가치
5. **지갑 허브** — 티켓/멤버십/포인트 통합 뷰

## 캡처 방법

```bash
# Maestro 기반 자동 캡처 (추천)
maestro test e2e/shared/capture-screenshots.yaml

# 또는 iOS 시뮬레이터 수동
xcrun simctl io booted screenshot store/screenshots/ios-67/01-discover.png

# Android 에뮬레이터 수동
adb shell screencap -p /sdcard/01-discover.png
adb pull /sdcard/01-discover.png store/screenshots/android-phone/
```

## 사용자 수동 단계

1. iOS: ASC (App Store Connect) → 버전 → 미디어 관리 → 해당 사이즈에 업로드
2. Android: Play Console → 스토어 등록 정보 → 그래픽 애셋 → 전화기/태블릿 스크린샷
3. 메타데이터 텍스트는 ASC/Play Console 에 직접 복붙 (이 파일들은 단일 진실 소스)
