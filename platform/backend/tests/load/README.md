# Pickket 부하 테스트 (Locust)

1000명 동시 접속 시뮬레이션으로 Pickket API 성능을 측정한다.

## 사전 조건

1. **Backend 서버** 실행 중 (`http://localhost:8001`)
2. **PostgreSQL / Redis** 실행 중
3. **시드 데이터**: `testuser0001@pickket.test` ~ `testuser1000@pickket.test` 계정이 DB에 존재해야 한다.
   - 비밀번호: `PickketTest2026!`
   - 이벤트 데이터가 최소 1건 이상 존재해야 한다.

## 설치

```bash
cd backend
.venv/bin/pip install locust
```

## 실행 방법

### CLI 모드 (헤드리스)

```bash
cd backend
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 1000 -r 50 -t 60s \
  --host http://localhost:8001
```

| 옵션      | 설명                          |
| --------- | ----------------------------- |
| `-u 1000` | 총 동시 유저 수               |
| `-r 50`   | 초당 유저 증가 속도 (50명/초) |
| `-t 60s`  | 테스트 지속 시간              |
| `--host`  | 대상 서버 URL                 |

### 단계별 부하 증가 (수동 제어)

```bash
# 가벼운 테스트 (100명)
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 100 -r 10 -t 30s --host http://localhost:8001

# 중간 부하 (500명)
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 500 -r 25 -t 60s --host http://localhost:8001

# 풀 부하 (1000명)
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 1000 -r 50 -t 120s --host http://localhost:8001
```

### Web UI 모드

```bash
.venv/bin/locust -f tests/load/locustfile.py --host http://localhost:8001
# 브라우저에서 http://localhost:8089 접속
```

### CSV 결과 내보내기

```bash
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 1000 -r 50 -t 60s \
  --host http://localhost:8001 \
  --csv=results/load_test
```

`results/load_test_stats.csv`, `results/load_test_stats_history.csv`, `results/load_test_failures.csv` 생성.

### HTML 리포트

```bash
.venv/bin/locust -f tests/load/locustfile.py --headless \
  -u 1000 -r 50 -t 60s \
  --host http://localhost:8001 \
  --html=results/load_test_report.html
```

## 시나리오 구성

### AnonymousUser (60% 비중)

미인증 공개 API만 호출.

| 엔드포인트                             | 가중치 | 설명          |
| -------------------------------------- | ------ | ------------- |
| `GET /api/v1/events/`                  | 5      | 이벤트 목록   |
| `GET /api/v1/events/{id}`              | 3      | 이벤트 상세   |
| `GET /api/v1/events/categories`        | 2      | 카테고리      |
| `GET /api/v1/events/search?q=...`      | 2      | 검색          |
| `GET /api/v1/events/featured`          | 2      | 추천 이벤트   |
| `GET /api/v1/events/trending`          | 2      | 인기 이벤트   |
| `GET /api/v1/events/ranking`           | 1      | 랭킹          |
| `GET /api/v1/events/opening-soon`      | 1      | 오픈 예정     |
| `GET /api/v1/events/{id}/transparency` | 1      | 투명성 보고서 |
| `GET /api/v1/events/{id}/similar`      | 1      | 유사 이벤트   |
| `POST /api/v1/events/{id}/view`        | 1      | 조회수 기록   |

### AuthenticatedUser (40% 비중)

로그인 후 인증 + 공개 API 혼합 호출.

| 엔드포인트                               | 가중치 | 설명           |
| ---------------------------------------- | ------ | -------------- |
| `GET /api/v1/users/me`                   | 3      | 프로필         |
| `GET /api/v1/events/`                    | 3      | 이벤트 목록    |
| `GET /api/v1/orders/my`                  | 3      | 내 주문        |
| `GET /api/v1/events/favorites`           | 2      | 즐겨찾기       |
| `GET /api/v1/notifications/`             | 2      | 알림           |
| `GET /api/v1/events/{id}`                | 2      | 이벤트 상세    |
| `GET /api/v1/events/recommended`         | 1      | 개인화 추천    |
| `GET /api/v1/notifications/unread-count` | 1      | 미읽은 알림 수 |
| `POST /api/v1/events/{id}/favorite`      | 1      | 좋아요 토글    |
| `GET /api/v1/orders/my/refunds`          | 1      | 환불 내역      |

## 결과 해석 가이드

### 핵심 지표

| 지표              | 양호    | 주의      | 위험    |
| ----------------- | ------- | --------- | ------- |
| **평균 응답시간** | < 200ms | 200-500ms | > 500ms |
| **95% 응답시간**  | < 500ms | 500ms-1s  | > 1s    |
| **99% 응답시간**  | < 1s    | 1-2s      | > 2s    |
| **실패율**        | < 1%    | 1-5%      | > 5%    |
| **RPS**           | > 500   | 200-500   | < 200   |

### 출력 예시 해석

```
Name                          # reqs    Avg   Min   Max   Med   req/s failures
GET /events/ (list)             1234    45     12   320    38   20.5   0(0.00%)
GET /events/{id} (detail)        890    52     15   450    42   14.8   2(0.22%)
POST /auth/login                 400   120     80   890   100    6.7   5(1.25%)
```

- **Avg**: 평균 응답 시간 (ms)
- **Med**: 중위 응답 시간 (50번째 백분위)
- **req/s**: 초당 요청 수
- **failures**: 실패 수 (비율)

### 주의사항

1. **Rate Limiting**: 백엔드에 rate limit 미들웨어가 있으므로, 높은 부하에서 429 응답이 발생할 수 있다.
2. **DB 부하**: 로컬 PostgreSQL은 프로덕션과 성능이 다르다. 프로덕션 벤치마크는 별도로 진행한다.
3. **Redis 캐시**: 대부분의 공개 API가 Redis 캐시를 사용하므로, 첫 요청 후 캐시 히트가 발생하여 응답이 빨라진다.
4. **로그인 실패**: testuser 계정이 DB에 없으면 인증 시나리오가 모두 스킵된다. 시드 데이터를 먼저 적재하라.
5. **결제 시나리오**: 실제 주문 생성은 부작용이 크므로 읽기 위주 엔드포인트만 호출한다.

## 트러블슈팅

### locust 명령어를 찾을 수 없음

```bash
# venv 경로를 명시적으로 사용
.venv/bin/locust -f tests/load/locustfile.py ...
```

### 연결 거부 (Connection refused)

```bash
# Backend 서버가 8001 포트에서 실행 중인지 확인
curl http://localhost:8001/api/v1/events/categories
```

### 모든 로그인이 실패함

```bash
# 테스트 유저 시드 데이터 확인
.venv/bin/python -c "
import asyncio
from app.core.database import async_engine
from sqlalchemy import text

async def check():
    async with async_engine.connect() as conn:
        result = await conn.execute(text(\"SELECT count(*) FROM users WHERE email LIKE '%pickket.test'\"))
        print('Test users:', result.scalar())

asyncio.run(check())
"
```

---

# Pickket 구매 피크 부하 테스트 (k6)

티켓 오픈 순간의 동시 구매 트래픽을 시뮬레이션하는 k6 부하 테스트.

## 사전 조건

1. **Backend 서버** 실행 중 (`http://localhost:8021`)
2. **PostgreSQL / Redis** 실행 중
3. **시드 데이터**: `testuser0001@seedtest.pickket.kr` ~ `testuser1000@seedtest.pickket.kr` 계정이 DB에 존재해야 한다.
   - 비밀번호: `PickketTest2026!`
   - 이벤트 및 티어 데이터가 최소 1건 이상 존재해야 한다.
4. **k6 바이너리**: `k6-v0.49.0-linux-amd64/k6` (프로젝트 루트 기준)

## 시나리오

| 시나리오    | 설명                                         | VU   | 지속시간 |
| ----------- | -------------------------------------------- | ---- | -------- |
| `ramp_up`   | 티켓 오픈 순간 (0→500 VU, 유지 2분)          | 500  | ~3분     |
| `spike`     | 급격한 트래픽 스파이크 (0→1000 VU, 유지 30s) | 1000 | ~50s     |
| `sustained` | 정상 상태 지속 부하                          | 200  | 5분      |

각 VU의 흐름: 로그인 → 이벤트/티어 탐색 → 대기열 진입 → 대기열 상태 폴링 → 구매 시도

## 실행 방법

```bash
# 프로젝트 루트에서 실행
K6=./k6-v0.49.0-linux-amd64/k6

# 전체 시나리오 (ramp_up + spike + sustained 동시)
$K6 run backend/tests/load/k6-purchase-peak.js

# 특정 시나리오만 실행
$K6 run backend/tests/load/k6-purchase-peak.js --scenario ramp_up
$K6 run backend/tests/load/k6-purchase-peak.js --scenario spike
$K6 run backend/tests/load/k6-purchase-peak.js --scenario sustained
```

### 환경변수

| 변수          | 기본값                         | 설명                |
| ------------- | ------------------------------ | ------------------- |
| `K6_API_BASE` | `http://localhost:8021/api/v1` | API 베이스 URL      |
| `K6_EVENT_ID` | (자동 탐색)                    | 특정 이벤트 ID 지정 |
| `K6_TIER_ID`  | (자동 탐색)                    | 특정 티어 ID 지정   |

```bash
# 스테이징 환경 대상, 특정 이벤트 지정
K6_API_BASE=https://api-staging.pickket.kr/api/v1 \
K6_EVENT_ID=550e8400-e29b-41d4-a716-446655440000 \
K6_TIER_ID=660e8400-e29b-41d4-a716-446655440001 \
$K6 run backend/tests/load/k6-purchase-peak.js --scenario ramp_up
```

### JSON 결과 내보내기

```bash
$K6 run backend/tests/load/k6-purchase-peak.js \
  --out json=results/k6-purchase-peak.json
```

## 임계값 (Thresholds)

| 지표                    | 조건         | 설명             |
| ----------------------- | ------------ | ---------------- |
| `http_req_duration`     | p95 < 2000ms | HTTP 응답 시간   |
| `http_req_failed`       | rate < 5%    | HTTP 실패율      |
| `purchase_success_rate` | rate > 50%   | 구매 성공률      |
| `queue_wait_time`       | p95 < 30s    | 대기열 대기 시간 |

## 커스텀 메트릭

| 메트릭                  | 타입    | 설명                  |
| ----------------------- | ------- | --------------------- |
| `purchase_success`      | Counter | 구매 성공 횟수        |
| `purchase_fail`         | Counter | 구매 실패 횟수        |
| `purchase_success_rate` | Rate    | 구매 성공률           |
| `queue_wait_time`       | Trend   | 대기열 대기 시간 (ms) |

## 주의사항

1. **3개 시나리오를 동시에 실행하면** VU가 최대 1700까지 올라간다. 머신 리소스를 확인하라.
2. **Rate Limiting**: 429 응답은 정상적인 방어 동작이다. 구매 실패로 집계된다.
3. **Idempotency Key**: 각 구매 요청마다 고유 UUID를 생성한다. 중복 구매가 발생하지 않는다.
4. **대기열 미구현 시**: queue 엔드포인트가 404를 반환하면 자동으로 건너뛰고 구매를 시도한다.
5. **로컬 vs 프로덕션**: 로컬 테스트 결과는 프로덕션과 다르다. 스테이징 환경에서 실제 부하 테스트를 권장한다.
