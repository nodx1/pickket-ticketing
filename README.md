# Pickket — 통합 플랫폼 모노레포 (v3)

공정 티켓 플랫폼 Pickket의 전체 소스를 한 레포로 통합한 모노레포입니다.
기존 3개 레포(`pickket-v2`, `pickket-go`, `pickket-mobile`)를 합쳐 새 히스토리로 시작합니다.

## 구조

```
pickket-v3/
├── platform/     FastAPI 백엔드(SoT) + 소비자/관리자 웹 + 공유 패키지 + 엔진 (pnpm 모노레포)
│   ├── backend/      FastAPI + SQLAlchemy + Alembic + Celery (커머스 SoT)
│   ├── apps/
│   │   ├── consumer/ 소비자 웹 (Next.js 16)
│   │   └── admin/    관리자 대시보드 (Next.js 16)
│   ├── packages/     공유 lib/ui/store/contracts/tailwind-config
│   └── engine/       talkfile_engine (공정 추첨 E-S + 팬 가중치)
├── organizer/    주최자 SaaS 대시보드 (Next.js 16) — v2 백엔드에 HMAC write-through
└── mobile/       소비자 모바일 앱 (Expo 54 + RN) — v2 백엔드 API 소비
```

> **아키텍처**: `platform/backend`가 커머스 단일 진실원(SoT). `organizer`는 HMAC HTTP write-through, `mobile`은 순수 API 소비자. 도메인 표준 정본: `platform/docs/architecture/standards/DOMAIN_MODEL_STANDARD.md`.

## 빠른 시작 (각 앱 독립 실행)

```bash
# 인프라 (Docker — DB/Redis)
cd platform/docker && docker compose -p pickket-v2 up -d db redis

# 백엔드 (FastAPI :8021)
cd platform/backend && python -m venv .venv && .venv/bin/pip install -e . && \
  .venv/bin/alembic upgrade head && .venv/bin/uvicorn app.main:app --port 8021 --reload

# 소비자 웹 (:3020) / 관리자 (:3022)
cd platform && pnpm install && pnpm dev:consumer   # 또는 pnpm dev:admin

# 주최자 SaaS (:3013)
cd organizer && npm install && npm run dev

# 모바일 (Expo)
cd mobile && npm install && npx expo start
```

각 앱은 자기 `package.json`/lockfile/툴링을 그대로 유지합니다(나란히 모노레포). 통합 워크스페이스(turborepo) 전환은 로드맵 참조.

## 포트맵

| 서비스 | 포트 | DB | Redis |
|---|---|---|---|
| backend (FastAPI) | 8021 | 5435 | 6381 |
| consumer | 3020 | | |
| admin | 3022 | | |
| organizer | 3013 | 5434 | 6380 |
| mobile (Expo) | 8081 | (백엔드 경유) | |
| rise-engine | 8100 | | |

## 환경변수

각 앱의 `.env.example`을 복사해 `.env`(또는 `.env.local`)로 만들고 값을 채우세요. **실 시크릿은 절대 커밋 금지** (`.gitignore` 처리됨, 정본은 AWS Secrets Manager).

## 다음 단계 — 유지보수 정석화 로드맵

이 레포는 "나란히 모노레포"(1단계)로 시작합니다. 정석(turborepo 통합 + 계약중심 + 트렁크 기반 + CI 게이트)으로의 전환 계획은 [`docs/MONOREPO_ROADMAP.md`](docs/MONOREPO_ROADMAP.md) 참조.

## 온보딩

새 팀원은 [`docs/ONBOARDING.md`](docs/ONBOARDING.md)부터 읽으세요.
