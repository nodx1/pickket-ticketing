# Pickket Mobile — E2E Test Suite (Maestro)

## 구조

```
e2e/
├── README.md                    # 이 문서
├── config.yaml                  # Maestro workspace 설정 (smoke/ + full/)
├── run-matrix.sh                # i18n×theme 매트릭스 러너 (npm run e2e:matrix)
├── shared/                      # 공유 서브플로우 (runFlow ../shared/... 로 재사용)
│   ├── boot.yaml                # launchApp + Categories 대기 + 권한 팝업
│   ├── login-consumer.yaml      # mobile@pickket.kr 로그인
│   ├── ensure-logged-in.yaml    # 이미 로그인이면 no-op
│   └── logout.yaml              # 프로필 → 로그아웃
├── backend/                     # 백엔드 시드/리셋 스크립트
│   ├── README.md
│   └── seed-e2e.sh
├── smoke/                       # PR 차단 후보 (빠른 핵심 회귀)
│   ├── a11y-smoke.yaml
│   ├── booking-flow.yaml
│   ├── discover-feed.yaml
│   ├── event-detail.yaml
│   ├── guest-browse.yaml
│   └── login-flow.yaml
└── full/                        # nightly + main push (확장 시나리오)
    ├── deep-link.yaml
    ├── favorite-toggle.yaml
    ├── friends-access.yaml
    ├── language-switch.yaml
    ├── notification-settings.yaml
    ├── order-history.yaml
    ├── order-refund.yaml
    ├── price-watch.yaml
    ├── profile-menu.yaml
    ├── search-filter.yaml
    ├── session-expiry.yaml
    ├── signup-flow.yaml
    ├── ticket-qr.yaml
    └── wallet-overview.yaml
```

## 태그 체계

| 태그 | 대상 | 실행 주기 | PR 차단 |
|------|------|----------|---------|
| `smoke` | guest-browse, login-flow, discover-feed, event-detail, booking-flow, a11y-smoke | 모든 PR (예정) | ✅ (예정) |
| `full` | 나머지 16개 (wallet-overview, notification-settings, price-watch, friends-access, ticket-qr, order-refund 등) | nightly + main push | ❌ |
| `a11y` | a11y-smoke | smoke 와 동시 실행 | ✅ (예정) |
| `i18n` | language-switch | matrix runner 로 ko/en 양쪽 실행 | ❌ |

PR 차단 승격 조건: 백엔드 `APP_ENV=e2e` 인프라 완성 이후.
[docs/v2-team-requests/2026-04-09-e2e-infra.md](../docs/v2-team-requests/2026-04-09-e2e-infra.md) 참고.

## 로컬 실행

```bash
# 사전: Android 에뮬레이터 실행 + Metro dev server 실행 + APK 설치
# 사전: 백엔드 시드 (선택)
npm run e2e:seed

# 스모크만 (권장 — 빠름)
npm run e2e:smoke

# 전체 (nightly)
npm run e2e:full

# 단일 플로우
npm run e2e:single -- e2e/discover-feed.yaml

# 신규 플로우 레코딩
npm run e2e:record -- e2e/my-new.yaml

# i18n×theme 매트릭스 (ko + en)
npm run e2e:matrix
```

## 시각 회귀 (Jest 스냅샷)

Maestro 는 픽셀 비교 미지원 → 컴포넌트 단위 회귀는 Jest 스냅샷으로 보호.
- [src/__tests__/components/QRTicket.snapshot.test.tsx](../src/__tests__/components/QRTicket.snapshot.test.tsx) — 3 status 분기
- [src/__tests__/components/EventCard.snapshot.test.tsx](../src/__tests__/components/EventCard.snapshot.test.tsx) — variant 2 + perf budget 100회 < 1500ms

스냅샷 의도적 업데이트: `npx jest -u src/__tests__/components/`

## 성능 측정

- **컴포넌트 perf budget**: EventCard.snapshot.test.tsx 의 100회 렌더 < 1500ms (CI 지터 여유)
- **앱 시작 시간**: `adb shell am start -W kr.pickket.app/.MainActivity` 로 cold start ms 측정
- **Discover 스크롤 FPS**: `adb shell dumpsys gfxinfo kr.pickket.app framestats` (수동)

## testID 규칙

선택자는 **항상 testID 우선**. 텍스트/정규식은 i18n 에 취약하므로 fallback 만.

명명: `{screen}.{section}.{element}`

주요 레지스트리:

| testID | 위치 |
|--------|------|
| `tab.home`, `tab.discover`, `tab.search`, `tab.tickets`, `tab.profile` | app/(tabs)/_layout.tsx |
| `email-input`, `password-input`, `login-button`, `oauth-{provider}-button` | app/(auth)/login.tsx |
| `discover.card`, `discover.card.cta`, `discover.card.favorite`, `discover.card.share` | src/components/discover/DiscoverCard.tsx |
| `event.card.large.{eventId}`, `event.card.compact.{eventId}` | src/components/event/EventCard.tsx |
| `event.detail.bookNow`, `event.detail.priceAlert` | app/event/[id]/index.tsx, src/components/event/PriceAlertButton.tsx |
| `priceAlert.sheet` | src/components/event/PriceAlertButton.tsx |
| `profile.menu.wallet`, `profile.menu.orders`, `profile.menu.favorites`, `profile.menu.friends`, `profile.menu.memories`, `profile.menu.edit`, `profile.menu.language`, `profile.menu.notifications` | app/(tabs)/profile.tsx |
| `wallet.screen`, `wallet.summary` | app/wallet/index.tsx |
| `ticket.detail.screen`, `ticket.qr`, `ticket.card.{ticketId}` | app/ticket/[id].tsx, src/components/ticket/QRTicket.tsx, src/components/ticket/TicketCard.tsx |
| `orders.screen`, `order.card.{orderId}`, `order.detail.screen`, `order.detail.refund` | app/orders/index.tsx, app/order/[id].tsx |

신규 플로우 작성 시 컴포넌트에 testID 가 없다면 먼저 추가 후 flow 작성.

## 플로우 작성 규칙

1. **Boot 생략 금지** — 첫 줄은 항상 `runFlow: shared/boot.yaml`
2. **로그인 필요 시** — `runFlow: shared/ensure-logged-in.yaml`
3. **탭 이동** — `tapOn: { id: "tab.home" }` (절대 `tapOn: "Home"` 금지)
4. **태그 필수** — flow 상단 `tags: [smoke|full]`
5. **스크린샷** — 주요 분기점마다 `takeScreenshot: {flow_name}_{step}`
6. **타임아웃** — `extendedWaitUntil` timeout 은 5000~10000ms
7. **Back 복귀** — 각 flow 는 홈 화면 복귀로 종료 (다음 flow 영향 방지)

## 커버리지 매트릭스 (Phase E/F 기능)

| Phase | 기능 | Flow | 상태 |
|-------|------|------|------|
| F.1 | 지갑 허브 (티켓/멤버십/포인트) | `wallet-overview.yaml` | ✅ |
| E.5 | 알림 설정 + 신규 4개 카테고리 | `notification-settings.yaml` | ✅ |
| E.2 | PriceAlert 버튼 + 시트 | `price-watch.yaml` | ✅ |
| C.1 | 친구 화면 접근 + 검색 | `friends-access.yaml` | ✅ (backend 미구현 상태) |
| E.1 | Geofence / 위치 기반 알림 토글 | `notification-settings.yaml` 안에 포함 | ✅ (indirect — geofence 는 background lib, UI surface 없음) |
| E.3 | Weekly curation push | — | ⏸️ (서버 cron, 클라 수신 검증 불가) |
| E.4 | Friend activity push | — | ⏸️ (backend 미구현) |
| — | 티켓 상세 + QR 회전 | `ticket-qr.yaml` | ✅ (active 시드 없으면 QR 블록 graceful skip) |
| — | 주문 상세 + 환불 버튼 노출 | `order-refund.yaml` | ✅ (실제 환불은 미수행 — 가시성까지) |

## CI

[.github/workflows/e2e.yml](../.github/workflows/e2e.yml) — Android 에뮬레이터 기반.
현재 `workflow_dispatch` + `nightly` 만, PR 차단은 백엔드 E2E 인프라 완성 후.

## 디버깅

### 실패 스크린샷 위치
```
~/.maestro/tests/<timestamp>/<flow-name>/screenshots/
```

### Maestro Studio (시각적 디버깅)
```bash
maestro studio
```

### dev client + Metro 실행 상태로 돌려야 testID 적용
```bash
npx expo start --dev-client --port 8081 --clear
```
Metro 가 꺼져 있으면 설치된 APK 의 stale 번들을 사용하므로 신규 testID 가 반영되지 않음.
