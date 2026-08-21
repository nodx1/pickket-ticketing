# Pickket Mobile App

> Pickket 소비자용 iOS/Android 앱 (Expo 54 + React Native 0.81.5)
> v2 FastAPI 백엔드(`api.pickket.kr`)의 모바일 클라이언트

## Quick Start

```bash
npm install
npx expo start           # Expo dev server
npx expo run:ios         # iOS simulator
npx expo run:android     # Android emulator
npx jest                 # Jest 단위 테스트
npx tsc --noEmit         # 타입체크
```

## 주요 문서

- [MOBILE_MASTER_PLAN.md](./MOBILE_MASTER_PLAN.md) — 22주 로드맵 (Shape Up / Vertical Slice)
- [CLAUDE.md](./CLAUDE.md) — 프로젝트 컨텍스트 (slim)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 브랜치 전략 / 커밋 컨벤션 / PR 워크플로우
- [docs/adr/](./docs/adr/) — Architecture Decision Records
- [docs/architecture/standards/](./docs/architecture/standards/) — Standards (v2 참조 + 모바일 특화 부록)
- [docs/archive/WORK_ORDER_FROM_V2_2026-04-09.md](./docs/archive/WORK_ORDER_FROM_V2_2026-04-09.md) — v2 표준화 작업지시서 (보관)

## v2 의존성

- **백엔드 API**: `api.pickket.kr` (v2 FastAPI, :8021 dev)
- **공유 패키지**: `@pickket/lib`, `@pickket/store` (v2 모노레포 경유)
- **인증**: v2 JWT `/auth/refresh` 단일 의존 — [ADR-011](./docs/adr/ADR-011-mobile-auth-rebase.md)
- **Standards 정본**: [pickket.v2 `docs/architecture/standards/`](../pickket.v2/docs/architecture/standards/)

## 스택

- Expo 54, React Native 0.81.5, TypeScript
- Expo Router (파일 기반 라우팅)
- `expo-secure-store` (토큰 저장) — **AsyncStorage 인증 금지**
- Zustand + React Query
- i18n: ko / en (Cycle 2 확장 예정)
- Jest + React Native Testing Library, Maestro E2E

## 디렉토리 구조

```
app/                       # Expo Router 파일 기반 라우트
src/
  config/                  # api.ts, env.ts, theme.ts, queryClient.ts
  hooks/                   # useAuth, useEvents, ...
  components/              # ui/, event/, ticket/, ...
  lib/                     # storage, push, analytics, ssl-pinning
  i18n/                    # i18next + locales
  __tests__/               # Jest
docs/
  adr/                     # ADR-001, 002, 011
  architecture/standards/  # README + MOBILE_SPECIFIC_APPENDIX
  v2-team-requests/        # v2 팀 cross-request 아카이브
```

## 배포

EAS Build + TestFlight / Play Store Internal — Cycle 4 진입 시 본격 활성화.

```bash
eas build --profile development
eas build --profile preview
eas build --profile production
eas update --branch preview
```
