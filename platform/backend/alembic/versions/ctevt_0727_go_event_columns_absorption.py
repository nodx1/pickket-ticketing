"""Level2 컷오버 T2-EVT — go events 전용 컬럼 흡수(v2 = 유일 DB).

Revision ID: ctevt_0727
Revises: lvl2wh_0725
Create Date: 2026-07-27

go `events` 테이블에만 존재해 v2 로 투영되지 않던 컬럼을 가산(additive)으로 흡수한다.
go DB 제거 후에도 기능이 유지되려면 반드시 선행되어야 하는 스키마 확장.

핵심:
- `enabled_features TEXT[]` — go `require-feature.ts` 서버측 기능 게이트의 정본.
  없으면 토글 기능 API 가 전부 열리거나(fail-open) 전부 닫힌다(fail-closed). 비어있음이
  기본값이므로 NOT NULL DEFAULT '{}' 로 기존 행 안전.
- `event_type VARCHAR(50)` — 🔴 go EventType 은 13종+, v2 `category` 는 9종.
  toV2Category() 는 **손실 매핑**이라 역변환이 불가능하다(예: workshop/mice/conference →
  exhibition 으로 뭉개짐). go DB 를 지우기 전에 원본을 보존하지 않으면 **비가역 손실**.
  category 는 소비자 노출용 파생값으로 유지하고, event_type 이 주최자측 원본이다.
- 나머지는 go 주최자 콘솔 전용 설정(랜딩/도메인/대기열/RSVP/초대권 캡).

전부 nullable 또는 server_default 를 가지므로 무중단 적용 가능.
"""

from alembic import op


revision = "ctevt_0727"
down_revision = "lvl2wh_0725"
branch_labels = None
depends_on = None


# (컬럼명, 타입/제약) — ADD COLUMN IF NOT EXISTS 로 재실행 안전.
_COLUMNS: list[tuple[str, str]] = [
    # 🔴 기능 게이트 정본. go events.enabled_features TEXT[] NOT NULL DEFAULT '{}' 와 동일 계약.
    ("enabled_features", "TEXT[] NOT NULL DEFAULT '{}'::text[]"),
    # 🔴 go EventType 원본 보존(category 로의 손실 매핑을 되돌릴 유일한 수단).
    #    nullable — v2 네이티브 이벤트는 go event_type 개념이 없다.
    ("event_type", "VARCHAR(50)"),
    # 주최자 홈페이지 빌더 디자인(go events.homepage_design JSONB).
    ("homepage_design", "JSONB"),
    # 공개 랜딩 구성(go events.landing_config JSONB DEFAULT '{}').
    ("landing_config", "JSONB"),
    # 커스텀 도메인 — go 는 UNIQUE. v2 도 동일하게 전역 유니크(부분 인덱스로 NULL 다중 허용).
    ("custom_domain", "TEXT"),
    ("domain_metadata", "JSONB"),
    # 대기열(queue) 게이트 — checkout/initiate 가 read.
    ("queue_enabled", "BOOLEAN NOT NULL DEFAULT false"),
    ("queue_config", "JSONB"),
    # RSVP 상세 설정(v2 는 rsvp_enabled 불리언만 갖고 있었다).
    ("rsvp_config", "JSONB"),
    # 초대권(comp) 발급 상한.
    ("comp_capacity_cap", "INTEGER"),
]


def upgrade() -> None:
    for name, ddl in _COLUMNS:
        op.execute(f"ALTER TABLE events ADD COLUMN IF NOT EXISTS {name} {ddl}")

    # custom_domain 전역 유니크 — NULL 은 다중 허용해야 하므로 부분 유니크 인덱스.
    # (go 는 컬럼 UNIQUE 였으나 PG 의 UNIQUE 도 NULL 다중 허용이라 계약 동일.)
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_events_custom_domain "
        "ON events (custom_domain) WHERE custom_domain IS NOT NULL"
    )
    # 기능 게이트 조회는 이벤트 단건이므로 별도 인덱스 불필요.
    # event_type 은 주최자 목록 필터에 쓰이므로 인덱스.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type)"
    )
    # comp_capacity_cap 은 음수 금지(초대권 캡). 재시도 안전하게 catalog 가드.
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE events
            ADD CONSTRAINT ck_events_comp_capacity_cap_nonneg
            CHECK (comp_capacity_cap IS NULL OR comp_capacity_cap >= 0);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE events DROP CONSTRAINT IF EXISTS ck_events_comp_capacity_cap_nonneg"
    )
    op.execute("DROP INDEX IF EXISTS idx_events_event_type")
    op.execute("DROP INDEX IF EXISTS uq_events_custom_domain")
    for name, _ddl in reversed(_COLUMNS):
        op.execute(f"ALTER TABLE events DROP COLUMN IF EXISTS {name}")
