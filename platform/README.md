# Pickket (피켓) - 공정 추첨 기반 티켓 배분 플랫폼

공정 추첨 엔진과 AP(활동 포인트) 가중치를 활용한 티켓 예매 플랫폼입니다.
팬 활동 기반 가중 추첨, 멤버십 선판매, 대기열, 잔여 선착순 등
4단계 판매 방식을 지원하여 진정한 팬에게 공정하게 티켓이 배분되도록 설계되었습니다.

---

## 기술 스택

| 계층             | 기술                                    | 버전                     |
| ---------------- | --------------------------------------- | ------------------------ |
| **Frontend**     | Next.js (App Router), React, TypeScript | Next.js 16.1, React 19.2 |
| **스타일링**     | Tailwind CSS, Radix UI, shadcn/ui       | Tailwind v4              |
| **상태관리**     | Zustand, React Hook Form, Zod           | Zustand 5, Zod 4         |
| **Backend**      | FastAPI, Uvicorn                        | FastAPI 0.109+           |
| **ORM**          | SQLAlchemy (async) + Alembic            | SQLAlchemy 2.0+          |
| **데이터베이스** | PostgreSQL                              | 16                       |
| **캐시/브로커**  | Redis                                   | 7                        |
| **태스크 큐**    | Celery (worker + beat)                  | 5.3+                     |
| **엔진**         | Pure Python (NumPy, OR-Tools)           | Python 3.11+             |
| **모니터링**     | Prometheus, Sentry                      | -                        |
| **결제**         | 토스페이먼츠 (PortOne→전환)             | -                        |
| **배포**         | CapRover (X99 홈서버, deploy-app.sh)     | -                        |

---

## 아키텍처

```
                        +------------------+
                        |    Frontend      |
                        |  Next.js 16      |
                        |  (Consumer :3020)|
                        |  (Admin   :3022)|
                        +--------+---------+
                                 |
                            REST API
                                 |
                        +--------+---------+
                        |    Backend       |
                        |  FastAPI         |
                        |  (port 8021)     |
                        +--+-----+-----+--+
                           |     |     |
              +------------+     |     +------------+
              |                  |                   |
     +--------+------+  +-------+--------+  +-------+--------+
     |  PostgreSQL   |  |     Redis      |  |  Celery Worker |
     |  (port 5435)  |  |  (port 6381)   |  |  + Beat        |
     +---------------+  +----------------+  +-------+--------+
                                                    |
                                            +-------+--------+
                                            | Allocation     |
                                            | Engine         |
                                            | (공정추첨/가중)|
                                            +----------------+
```

### 주요 서비스 구성

- **Backend API**: FastAPI + Uvicorn, 비동기 요청 처리
- **Celery Worker**: 배분 실행, 결제 만료, 추첨, 큐 처리 등 비동기 태스크
- **Celery Beat**: 주기적 스케줄러 (배치 윈도우 체크, 결제 만료, 페이즈 전환 등)
- **Allocation Engine**: 공정 추첨, AP 가중치, 좌석 배정 핵심 알고리즘

---

## 빠른 시작

### 사전 요구사항

- Docker & Docker Compose
- Python 3.11+
- Node.js 20+ & pnpm
- PostgreSQL 16 (Docker로 대체 가능)
- Redis 7 (Docker로 대체 가능)

### 1. 저장소 클론

```bash
git clone git@github.com:onlywon/pickket.io.git
cd pickket.io
```

### 2. 환경 변수 설정

```bash
cp docker/.env.example docker/.env
# .env 파일을 편집하여 필수 값 설정
```

### 3. Docker Compose로 인프라 실행

```bash
cd docker
docker compose -p pickket-v2 up -d db redis
```

### 4. 로컬 개발

#### Backend

```bash
cd backend
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8021 --reload
```

#### Frontend

```bash
pnpm dev:consumer    # :3020
pnpm dev:admin       # :3022
```

#### Celery Worker & Beat

```bash
cd backend
.venv/bin/celery -A app.core.celery_app:celery_app worker --loglevel=info --concurrency=2
.venv/bin/celery -A app.core.celery_app:celery_app beat --loglevel=info
```

---

## 프로젝트 구조

```
pickket.v2/
├── backend/                    # FastAPI 백엔드
│   ├── app/
│   │   ├── api/v1/             # REST API 엔드포인트
│   │   ├── core/               # 핵심 설정 (config, database, redis, celery, security)
│   │   ├── models/             # SQLAlchemy 모델
│   │   ├─�� schemas/            # Pydantic 스키마
│   │   ├── services/           # 비즈니스 로직
│   │   ├── repositories/       # 데이터 접근 계층
│   │   ├── tasks/              # Celery 비동기 태스크
│   │   └── middleware/         # 미들웨어 (metrics, rate_limit, request_id)
│   ├── alembic/               # DB 마이그레이션 (105개+)
│   └── pyproject.toml
│
├── apps/
│   ├── consumer/              # Next.js 소비자 웹 (pickket.kr, :3020)
│   ├── admin/                 # Next.js 관리자 포탈 (admin.pickket.kr, :3022)
│   └── mobile/                # Expo 52 + React Native 0.76 (개발 대기)
│
├── packages/                  # 공유 패키지
│   ├── lib/                   # API 클라이언트/유틸/타입
│   ├── ui/                    # shadcn/ui 기반 공용 컴포넌트
│   ├── store/                 # Zustand 공용 스토어
│   ├── tailwind-config/       # 공용 globals.css/postcss 설정
│   └── mcp-dev-server/        # 팀 협업 MCP 서버
│
├── engine/                     # 배분 엔진 (Pure Python)
│   └── talkfile_engine/
│       ├── vcg.py             # 공정 추첨 알고리즘
│       ├── lottery.py         # AP 가중 추첨
│       ├── fan_weight.py      # 팬 가중치 계산 (10종 EventType)
│       ├── seat_assigner.py   # 좌석 자동 배정
│       ├── orchestrator.py    # 배분 오케스트레이션
│       └── ...
│
├── docker/                    # docker-compose.yml, .env
├── infra/                     # AWS 인프라 설정
├── scripts/                   # CI, E2E, 보안 스크립트
├── docs/                      # 문서 (계획서 12개, 아키텍처, 운영, 법률 등)
└── .github/workflows/         # CI/CD 워크플로우 (12개)
```

---

## 판매 방식 (Sale Modes) — v3.0

4단계 순차 진행:

| 순서 | 코드값            | 공식 명칭         | 설명                          |
| ---- | ----------------- | ----------------- | ----------------------------- |
| 1    | `fanclub_presale` | **멤버십 선판매** | 커뮤니티 회원 우선 구매       |
| 2    | `point_lottery`   | **공정 추첨**     | AP 가중치 기반 공정 추첨 배분 |
| 3    | (queue)           | **대기열 판매**   | 랜덤 순번 대기열              |
| 4    | `fixed_fcfs`      | **잔여 선착순**   | 잔여석 정가 선착순 구매       |

---

## 결제 플로우

```
구매 요청 → PAYMENT_REQUIRED 주문 + PENDING 티켓 생성
    → 결제 진행 (PortOne)
    → 웹훅 수신 / 결제 확인
    → CONFIRMED 주문 + ACTIVE 티켓
```

---

## 수수료 정책 (올인 가격)

- **소비자**: 표시가 = 결제가 (₩2,000 예매수수료 사전 포함, AP로 최대 70% 할인)
- **주최자**: 판매금액의 5% (PG 수수료 플랫폼 부담)
- **리세일**: 차익의 50% 주최자 + 10% 플랫폼 (정가 양도 시 0원)

---

## 배포 (2026-07 — AWS ECS 철거, CapRover 단일)

CapRover 단일서버(X99 `192.168.0.9:3000`)에 배포합니다. 옛 AWS ECS/ECR/GitHub Actions 파이프라인은 **폐기**.

```
로컬 커밋(main HEAD) → bash scripts/ops/deploy-app.sh <backend|consumer|admin|organizer>
  → 관문(앱이름 입력) → git archive HEAD 타르볼 → CapRover API 업로드
  → 빌드 6~18분(blue/green 없음, prod 직배포) → 헬스(/api/health/ready) → OPS_BOARD 기록
```
- 스테이징 없음. 마이그레이션 수동 선적용(런북 `docs/ops/runbooks/routine-마이그레이션.md`).

---

## 라이선스

[라이선스 정보 추가 예정]
