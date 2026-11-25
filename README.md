# 피켓 예매 플랫폼 (pickket-ticketing)

주최사가 정한 가중치로 공정하게 추첨해 표를 나누는 예매 플랫폼이다.

- **피켓**: 팬이 응모하고, 당첨되면 결제하고, 입장권을 받는 사이트
- **피켓고**: 주최사 대시보드. 이벤트를 만들고, 가중치 추첨을 설정하고, 공정성 증명서를 발행하고, 현장 입장을 관리한다
- **현장 단말**: 입장권 회전 QR을 읽어 입장을 판정한다(웹 단말, REST·Socket.IO)

이 저장소는 「가중치 추첨 알고리즘 적용과 파트너사 연결 기능 개발 용역」(2026. 10. 1. ~ 2026. 11. 30.)의 소스코드 결과물이다.

## 구조

```
platform/       FastAPI 백엔드(커머스 기준 서버) + 소비자·관리자 웹 + 공유 패키지 + 추첨 엔진
  backend/        FastAPI · SQLAlchemy · Alembic · Celery
  apps/consumer/  피켓 (Next.js)
  apps/admin/     관리자 (Next.js)
  engine/         추첨 엔진 talkfile_engine (가중 비복원 추출, 가중 VCG, Merkle)
  docker/         docker compose 설정
organizer/      피켓고 — 주최사 대시보드·웹 현장 단말 (Next.js)
mobile/         피켓 모바일 앱 (Expo)
scripts/        배포·백업·점검 스크립트
docs/deliverables/  과업 붙임 문서와 증빙
```

## 과업지시서 항목과 코드 위치

| 과업지시서 | 코드 |
|---|---|
| 가중치 추첨 데이터·캐싱, VCG 기반 가중 공정 추첨 | `platform/backend/app/services/fairness_service.py`, `platform/engine/talkfile_engine/` |
| Merkle 트리 무결성, 공정성 증명서 | `platform/engine/talkfile_engine/merkle.py`, `platform/apps/consumer/src/app/[locale]/fairness/` |
| 계정 복제 차단, Slash, 누적 시간 가중치 | `platform/backend/app/services/sanction_service.py`, `tenure_service.py` |
| TimescaleDB 시계열 로그 | `platform/backend/app/services/timeseries_log.py`, `alembic/versions/timeseries_1117_timescale_logs.py` |
| 현장 단말 입장권 검증, Socket.IO | `platform/backend/app/services/onsite_service.py`, `app/realtime/` |
| PG 결제(나이스페이), 주최사 PG 직결(무경유) | `platform/backend/app/services/nicepay_gateway.py`, `direct_settlement.py` |
| Pull 구조 연동, append-only 감사 로그 | `platform/backend/app/services/integration_ledger.py` |
| 지도 API 연동 | `platform/backend/app/services/map_service.py` |
| 주최사 대시보드, 현장 입장 관리 | `organizer/src/app/(dashboard)/events/[eventId]/` (`lottery-policy`, `fairness`, `onsite`, `settlement`) |

과업으로 추가한 DB 변경은 `platform/backend/alembic/versions/`의 7건이다. 적용 순서대로 `fairness_1117`(가중치 추첨·공정성 증명서), `timeseries_1117`(시계열 로그), `sanctions_1117`(계정 제재), `onsite_1117`(현장 단말), `integration_1117`(연동 원장·직결 정산), `poolunique_1117`(추첨 풀 중복 차단), `venuecoords_1120`(장소 좌표)이다.

## 로컬 실행

```bash
# DB(TimescaleDB)·Redis
cd platform/docker && docker compose -p pickket-ticketing -f docker-compose.yml -f docker-compose.timescale.yml up -d db redis

# 백엔드 (:8021)
cd platform/backend && python -m venv .venv && .venv/bin/pip install -e . \
  && .venv/bin/alembic upgrade head && .venv/bin/uvicorn app.main:app --port 8021

# 피켓 (:3020), 관리자 (:3022)
cd platform && pnpm install && pnpm dev:consumer   # 또는 pnpm dev:admin

# 피켓고
cd organizer && npm install && npm run dev
```

설정값은 각 폴더의 `.env.example`을 복사해 채운다. 비밀값(상점키, 서명키 등)은 환경 변수로만 넣고 저장소에 두지 않는다.

## 검증

| 종류 | 실행 |
|---|---|
| 백엔드 테스트 | `cd platform/backend && .venv/bin/python -m pytest` |
| 추첨 엔진 테스트 | `cd platform/engine && python -m pytest` |
| 피켓·피켓고 테스트 | `pnpm test`(platform), `npm test`(organizer) |
| 실환경 시나리오(추첨·증명서) | `platform/backend/scripts/verify/e2e_fairness_pg.py` |
| 실환경 시나리오(현장·결제) | `platform/backend/scripts/verify/e2e_onsite_pg.py` |
| 응모 부하 테스트 | `platform/backend/scripts/verify/loadtest_apply.py` |

결과와 화면 캡처는 `docs/deliverables/evidence/`에 있다.

## 문서

- `docs/deliverables/01-연동-대상-규격-확정서.md`
- `docs/deliverables/02-부하-테스트-결과.md`
- `docs/deliverables/03-코드-리뷰-기록.md`

기술 구조 명세서와 최종 완료 보고서는 별도 문서로 제출한다.

## 이력

첫 커밋은 과업 착수 전 운영 코드(2026-08-21 기준)를 한 번에 가져온 기준본이다. 내부 설계·사업 문서와 접속 정보 문서는 넣지 않았다. 그 뒤 커밋이 과업 기간(2026-11-17~)의 작업이다.
