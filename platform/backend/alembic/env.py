import os
import re
import sys
from logging.config import fileConfig
from pathlib import Path

from dotenv import load_dotenv

# Load .env from backend directory so alembic picks up DATABASE_URL_SYNC
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from alembic import context
from app.core.database import Base
from app.models import (  # noqa: F401
    Allocation,
    AllocationResult,
    Attendance,
    AuditEntryModel,
    Bid,
    Event,
    EventStaffAssignment,
    EventStaffRole,
    GroupMemberModel,
    GroupModel,
    LotteryEntry,
    LotteryPool,
    NotificationModel,
    Order,
    PhaseConfig,
    PriceAlertModel,
    ResaleBuyOrderModel,
    ResaleListingModel,
    Seat,
    SeatTier,
    SessionHistoryModel,
    Ticket,
    OwnershipTransfer,
    User,
    UserInteraction,
    Venue,
    VenueSection,
    WaitlistEntryModel,
    # Organizer portal models
    OrganizerProfile,
    OrganizerRequest,
    OpenNotice,
    ParticipantSlot,
    ParticipantAssignment,
    Discount,
    FinalCall,
    Promotion,
    BridgePage,
    PartnershipRequest,
    PackageProduct,
    PackageItem,
    TicketIssuanceRequest,
    ExchangeRate,
    Partner,
    NftTicket,
    PublicFacility,
    ProxyBooking,
    DelegationToken,
)

from sqlalchemy import engine_from_config
from sqlalchemy import pool

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# 🔴 접속 대상을 **항상 눈에 보이게** 한다 (2026-07-31 실사고).
#
# alembic.ini 의 `sqlalchemy.url` 은 로컬 개발용(localhost)이 박혀 있다. prod 마이그레이션을
# 돌리면서 `DATABASE_URL` 을 넘겼는데 **이 파일이 그 이름을 안 본다** — 조용히 로컬 dev DB 에
# 걸리고 alembic 은 "raffbase_0731 (head)" 라고 **성공을 보고**했다.
# prod 를 psql 로 따로 확인해서 잡았다. 안 봤으면 배포 후 없는 컬럼을 읽고 깨졌을 것이다.
#
# 이름을 기억하는 방식은 실패한다 ⟹ **무엇에 접속하는지 매번 출력**한다.
#   · `DATABASE_URL_SYNC` 가 있으면 그것을 쓴다(운영 경로)
#   · 없으면 alembic.ini 값(로컬)을 쓰되 **경고를 띄운다**
# 자격증명은 절대 찍지 않는다 — host:port/db 만.
database_url_sync = os.getenv("DATABASE_URL_SYNC")
if database_url_sync:
    config.set_main_option("sqlalchemy.url", database_url_sync)
    _source = "DATABASE_URL_SYNC"
else:
    _source = "alembic.ini (로컬 기본값)"

_effective = config.get_main_option("sqlalchemy.url") or ""
_target = re.sub(r"^.*@", "", _effective) or "(미설정)"
print(f"[alembic] 접속 대상: {_target}  ← {_source}", file=sys.stderr)
if not database_url_sync:
    print(
        "[alembic] ⚠️ DATABASE_URL_SYNC 가 없어 alembic.ini 의 로컬 주소를 씁니다. "
        "운영 DB 에 적용하려면 DATABASE_URL_SYNC 를 지정하십시오. "
        "(`DATABASE_URL` 은 이 파일이 보지 않습니다)",
        file=sys.stderr,
    )
    # 🔴 경고만으로는 원래 사고가 그대로 재현된다 (2026-07-31 코덱스 감사).
    #    `DATABASE_URL` 만 주고 upgrade 를 돌리면 alembic 은 그 값을 **무시하고**
    #    로컬 ini DB 에 마이그레이션을 **실제로 실행**한 뒤 "성공" 을 보고했다.
    #    경고 한 줄은 스크롤에 묻힌다 — 그때 내가 놓친 것이 정확히 그 상황이다.
    #    ⟹ **틀린 이름을 줬을 때는 아예 실행하지 않는다.** 읽기 명령(current/heads)은
    #      로컬에서도 자주 쓰므로 막지 않고, **DB 를 바꾸는 명령만** 끊는다.
    _WRITE_CMDS = {"upgrade", "downgrade", "stamp", "merge"}
    _argv = set(sys.argv)
    if _argv & _WRITE_CMDS and "DATABASE_URL" in os.environ:
        raise SystemExit(
            "[alembic] 🔴 중단 — `DATABASE_URL` 을 주셨는데 이 파일은 그 이름을 보지 않습니다.\n"
            "           그대로 진행하면 alembic.ini 의 **로컬 DB** 에 마이그레이션이 실행되고\n"
            "           '성공' 이 보고됩니다(2026-07-31 실사고).\n"
            "           운영 DB 에 적용하려면: DATABASE_URL_SYNC=<url> alembic upgrade <rev>"
        )

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

LEGACY_REFLECTED_INDEX_PREFIXES = ("idx_fk_", "idx_point_")
# PostgreSQL-only expression indexes (GIN to_tsvector 등)는 모델 메타데이터로
# 표현 불가 → reflected 이름 정확 매칭으로 drift 검사에서 억제.
LEGACY_REFLECTED_INDEX_NAMES = {
    "idx_event_fts",  # events GIN to_tsvector(...) FTS 인덱스 (마이그레이션 관리)
}
LEGACY_METADATA_INDEX_NAMES = {
    # DB keeps legacy idx_* names; ignore metadata ix_* aliases for drift checks.
    "ix_point_transactions_user_id",
    "ix_point_transactions_wallet_id",
    "ix_point_wallets_user_id",
}

# 단계6-B: 폐기 예정 레거시(금지 도메인 dutch/VCG 잔재 + 일회성 백업). 데이터·app·go
# 참조 0 확인됨(2026-06-01)이나 contract 단계 drop은 cross-request 통보 후로 보류.
# 그 전까지 drift 검사(빈-diff 게이트)에서 제외 — drop 자체는 legacy_drop 마이그로 별도 수행.
# ⚠️ 보류 해제(실제 drop) 시 이 목록에서도 제거할 것.
LEGACY_PENDING_DROP_TABLES = {
    "dutch_auction_states",
    "dutch_purchases",
    "user_consents_dedup_backup",
}
# (table, column) — 같은 사유로 drop 보류 중인 레거시 컬럼.
LEGACY_PENDING_DROP_COLUMNS = {
    ("events", "remainder_dutch_step_pct"),
    ("events", "remainder_dutch_floor_pct"),
}

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
        )

        with context.begin_transaction():
            context.run_migrations()


def include_object(object_, name, type_, reflected, compare_to):
    """Suppress known legacy drift during autogenerate/check (빈-diff 게이트용)."""
    if type_ == "index" and name:
        if reflected and name.startswith(LEGACY_REFLECTED_INDEX_PREFIXES):
            return False
        if reflected and name in LEGACY_REFLECTED_INDEX_NAMES:
            return False
        if not reflected and name in LEGACY_METADATA_INDEX_NAMES:
            return False
    # 단계6-B: drop 보류 중인 레거시 테이블/컬럼은 drift 검사에서 제외.
    if type_ == "table" and name in LEGACY_PENDING_DROP_TABLES:
        return False
    if type_ == "column" and reflected:
        table_name = getattr(getattr(object_, "table", None), "name", None)
        if (table_name, name) in LEGACY_PENDING_DROP_COLUMNS:
            return False
    return True


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
