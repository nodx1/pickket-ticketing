# Pickket Infrastructure

## 아키텍처 개요

```
                              Cloudflare CDN / WAF / DDoS
                                     |
                    +----------------+------------------+
                    |                |                   |
              www.pickket.kr   go.pickket.kr   api.pickket.kr
              admin.pickket.kr
                    |                |                   |
                    +----------------+------------------+
                                     |
                         AWS Application Load Balancer
                    +----------------+------------------+
                    |                |                   |
              +-----------+  +-----------+  +------------------+
              | Consumer  |  | Organizer |  | Backend (API)    |
              | Next.js   |  | Go        |  | FastAPI + Uvicorn|
              | ECS Task  |  | ECS Task  |  | ECS Task x4 wkr |
              +-----------+  +-----------+  +------------------+
                    |                |                   |
              +-----------+                    +--------+--------+
              | Admin     |                    |                 |
              | Next.js   |             +------+------+   +-----+-----+
              | ECS Task  |             | RDS         |   | ElastiCache|
              +-----------+             | PostgreSQL  |   | Redis 7    |
                                        | Multi-AZ    |   | TLS        |
                                        +------+------+   +-----------+
                                               |
                                        +------+------+
                                        | RDS Read    |
                                        | Replica     |
                                        +-------------+
                                               |
                                        +------+------+
                                        | S3/R2       |
                                        | (Backups +  |
                                        |  Uploads)   |
                                        +-------------+
```

## 서비스 구성

| 서비스             | 런타임                          | 리소스 (권장)        | ECS 서비스명          |
| ------------------ | ------------------------------- | -------------------- | --------------------- |
| Consumer           | Node.js 20 (Next.js standalone) | 512MB RAM, 0.5 vCPU  | pickket-consumer      |
| Organizer (Go)     | Go (standalone)                 | 512MB RAM, 0.5 vCPU  | pickket-organizer     |
| Admin              | Node.js 20 (Next.js standalone) | 256MB RAM, 0.25 vCPU | pickket-admin         |
| Backend API        | Python 3.11 (Uvicorn 4 workers) | 1GB RAM, 1 vCPU      | pickket-backend       |
| Celery Worker      | Python 3.11 (concurrency=2)     | 512MB RAM, 0.5 vCPU  | pickket-celery-worker |
| Celery Beat        | Python 3.11                     | 256MB RAM, 0.25 vCPU | pickket-celery-beat   |
| PostgreSQL         | RDS PostgreSQL 16 (Multi-AZ)    | db.t3.medium         | —                     |
| PostgreSQL Replica | RDS Read Replica                | db.t3.medium         | —                     |
| Redis              | ElastiCache Redis 7 (TLS)       | cache.t3.micro       | —                     |

## AWS 인프라 정보

| 항목           | 값                                                       |
| -------------- | -------------------------------------------------------- |
| AWS 계정       | 794562054294                                             |
| 리전           | ap-northeast-2 (서울)                                    |
| ECS 클러스터   | pickket                                                  |
| ALB            | pickket-alb-452124900.ap-northeast-2.elb.amazonaws.com   |
| ECR 레지스트리 | 794562054294.dkr.ecr.ap-northeast-2.amazonaws.com        |
| RDS 엔드포인트 | pickket-db.cnoy08w8c4nc.ap-northeast-2.rds.amazonaws.com |
| ElastiCache    | master.pickket-redis-std.mpakkf.apn2.cache.amazonaws.com |

### ECR 리포지토리

| 이미지         | ECR 경로          |
| -------------- | ----------------- |
| Backend        | pickket/backend   |
| Consumer       | pickket/consumer  |
| Organizer (Go) | pickket/organizer |
| Admin          | pickket/admin     |

> Celery Worker/Beat는 Backend 이미지를 공유 (entrypoint만 다름)

## 환경변수

ECS 태스크 정의에서 환경변수를 관리합니다. 시크릿은 AWS Secrets Manager 또는 Parameter Store 사용 권장.

### 필수 시크릿 (프로덕션)

```
SECRET_KEY              # JWT 서명 키 (최소 32자)
DATABASE_URL            # PostgreSQL 연결 URL (asyncpg)
DATABASE_URL_SYNC       # PostgreSQL 동기 연결 URL (Celery용)
DATABASE_READ_URL       # Read Replica 연결 URL (선택)
REDIS_URL               # Redis 연결 URL (TLS)
PORTONE_API_SECRET      # PortOne 결제 API 시크릿
PORTONE_WEBHOOK_SECRET  # PortOne 웹훅 시크릿
```

## DR (Disaster Recovery) 계획

### 목표

- **RTO (Recovery Time Objective)**: 4시간
- **RPO (Recovery Point Objective)**: 1시간

### 백업 전략

| 대상           | 방법                                  | 주기                                        | 보관 기간                  |
| -------------- | ------------------------------------- | ------------------------------------------- | -------------------------- |
| PostgreSQL     | RDS 자동 스냅샷 + pg_dump (S3 업로드) | 스냅샷: 일 1회, pg_dump: Celery Beat 매시간 | 스냅샷: 7일, pg_dump: 30일 |
| PostgreSQL WAL | RDS 자동 연속 백업                    | 실시간                                      | 7일                        |
| Redis          | ElastiCache 자동 스냅샷               | 일 1회 (appendfsync everysec)               | 7일                        |
| 소스 코드      | Git (GitHub)                          | 실시간                                      | 영구                       |
| 환경변수       | ECS 태스크 정의 + Secrets Manager     | 변경 시                                     | 버전 관리                  |

### 복구 절차

#### 시나리오 1: ECS 서비스 장애

1. CloudWatch 알람 확인
2. ECS 서비스 강제 재배포: `aws ecs update-service --cluster pickket --service <name> --force-new-deployment`
3. 이전 태스크 정의로 롤백: `aws ecs update-service --cluster pickket --service <name> --task-definition <prev-taskdef-arn>`
4. 복구 불가 시 docker-compose.prod.yml로 대체 배포 (4시간 이내)

#### 시나리오 2: 데이터베이스 손상

1. RDS 자동 스냅샷 또는 S3의 pg_dump 백업 확인
2. RDS 시점 복원 (Point-in-Time Recovery) 또는 새 인스턴스 생성
3. 백업 복원: `pg_restore -d pickket_prod < backup.dump`
4. ECS 태스크 정의의 DATABASE_URL 업데이트
5. Alembic 마이그레이션 상태 확인: `alembic current`
6. ECS 서비스 재배포

#### 시나리오 3: 전체 인프라 장애 (AWS 리전 장애)

1. docker-compose.prod.yml 사용하여 대체 서버에 배포
2. Cloudflare DNS를 대체 서버 IP로 변경 (TTL 5분)
3. S3 백업에서 DB 복원
4. 서비스 가동 확인
5. AWS 복구 후 원래 인프라로 복귀

### 복구 테스트

- 분기 1회 DR 훈련 실시
- 백업 복원 시간 측정 및 RTO 충족 여부 확인
- 결과 문서화 (`docs/dr-test-results/`)

## 모니터링 스택

| 도구                 | 용도                     | 설정                   |
| -------------------- | ------------------------ | ---------------------- |
| Sentry               | 에러 트래킹              | `SENTRY_DSN` 환경변수  |
| CloudWatch           | ECS 서비스 메트릭 + 로그 | AWS 콘솔               |
| OpenTelemetry        | 분산 추적                | `OTEL_ENABLED=true`    |
| Cloudflare Analytics | CDN/트래픽               | Cloudflare 대시보드    |
| Slack/Discord        | 운영 알림                | `ALERTING_WEBHOOK_URL` |

## 스케일링 전략

### 수평 스케일링 (ECS)

- Backend API: ECS 서비스 desiredCount 증가 + ALB 타겟 그룹 자동 등록
- Celery Worker: ECS 서비스 desiredCount 증가
- Consumer/Organizer/Admin: ECS 서비스 desiredCount 증가

### 수직 스케일링

- ECS 태스크 정의에서 CPU/Memory 제한 조정
- RDS 인스턴스 클래스 업그레이드
- ElastiCache 노드 타입 업그레이드

### Auto Scaling (권장)

- ECS Service Auto Scaling: CPU/메모리 사용률 기반
- Target Tracking: 평균 CPU 70% 유지
- Step Scaling: 피크 시 최대 N개 태스크

### Read Replica

- `DATABASE_READ_URL` 환경변수로 읽기 트래픽 분산
- 미설정 시 Write DB에 자동 폴백

## 배포

### 수동 배포 (ECR → ECS)

```bash
# 1. ECR 로그인
aws ecr get-login-password --region ap-northeast-2 | \
  docker login --username AWS --password-stdin 794562054294.dkr.ecr.ap-northeast-2.amazonaws.com

# 2. 빌드 & 푸시
docker build -f backend/Dockerfile -t 794562054294.dkr.ecr.ap-northeast-2.amazonaws.com/pickket/backend:latest .
docker push 794562054294.dkr.ecr.ap-northeast-2.amazonaws.com/pickket/backend:latest

# 3. ECS 서비스 업데이트
aws ecs update-service --cluster pickket --service pickket-backend --force-new-deployment
```

### CI/CD (GitHub Actions)

- `.github/workflows/deploy-aws.yml` — workflow_dispatch 트리거
- 6단계: build → migrate(one-off ECS task) → capture-taskdefs → deploy (6 services) → smoke-test → rollback (실패 시)
- `.github/workflows/aws-ops-readiness.yml` — 운영 준비 검증용 수동 workflow
  - `scripts/ci/aws_post_deploy_smoke.sh`로 ECS 상태 + `/health/detailed` 검증
  - 필요 시 `python scripts/backup_restore_drill.py`를 ECS one-off task로 실행

### DB 마이그레이션

```bash
# 저장소 스크립트 사용
ECS_CLUSTER=pickket ECS_SERVICE=pickket-backend AWS_RUN_COMMAND="alembic upgrade head" \
  ./scripts/ci/aws_run_backend_task.sh
```

## 파일 구조

```
infra/
├── README.md                    # 이 파일 (인프라 개요)
├── docker-compose.prod.yml      # 프로덕션용 Docker Compose (ECS 장애 시 대체 배포)
└── legacy/
    └── deploy-railway.yml       # (아카이브) Railway 배포 워크플로우
```
