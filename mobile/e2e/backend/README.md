# E2E 백엔드 시드 / 리셋

## 개요

Maestro E2E 는 v2 백엔드(`/home/oem/Desktop/pickket.v2/backend`) 를 실제로 호출합니다.
결정적인 테스트를 위해 **고정 계정 + 고정 이벤트 데이터** 가 DB 에 있어야 합니다.

## 고정 계정

| 역할 | 이메일 | 비밀번호 | 용도 |
|------|--------|---------|------|
| 일반 소비자 | `mobile@pickket.kr` | `Mobile1234A` | smoke 전체 |
| VIP (포인트/멤버십) | `vip@pickket.kr` | `Vip1234A` | F.2 wallet 플로우 (TODO) |
| 친구 A | `friend-a@pickket.kr` | `Friend1234A` | E.4 친구 플로우 (TODO) |
| 친구 B | `friend-b@pickket.kr` | `Friend1234A` | E.4 친구 수락 (TODO) |

## 실행

```bash
# 기본 — 기존 seed_demo.py 재사용
bash e2e/backend/seed-e2e.sh

# 커스텀 백엔드 경로
PICKKET_V2_BACKEND=/path/to/backend bash e2e/backend/seed-e2e.sh
```

## v2 팀 의존성 (TODO)

현재는 기존 `seed_demo.py` 를 그대로 재사용하고 있어서 로컬 개발 DB 를 오염시킵니다.
완전히 격리된 E2E 실행을 위해서는 v2 백엔드에 다음이 필요합니다:

1. `APP_ENV=e2e` 전용 DB 스키마 분기
2. `scripts/seed_e2e.py` — 결정론적 픽스쳐 (UUID 고정, 날짜 상대시간)
3. `scripts/reset_e2e.py` — E2E 스키마 truncate

요청 문서: [docs/v2-team-requests/2026-04-09-e2e-infra.md](../../docs/v2-team-requests/2026-04-09-e2e-infra.md)
