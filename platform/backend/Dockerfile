# Build: 2026-03-04-v3
# SECURITY: base images should be pinned to a SHA256 digest for reproducibility.
#   FROM python:3.11-slim@sha256:<digest> AS builder
# Digest pinning is DEFERRED — must be fetched online (docker manifest inspect
# python:3.11-slim) and refreshed via Renovate/Dependabot. Pin before launch.
# renovate: datasource=docker depName=python
# ── Stage 1: Builder ─────────────────────────────────────────────────
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /build

# Install build dependencies required by asyncpg, bcrypt, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libjpeg62-turbo-dev \
        libwebp-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy engine package manifests and source so it can be installed as a dependency
COPY engine/pyproject.toml /engine/pyproject.toml
COPY engine/talkfile_engine /engine/talkfile_engine

# Install engine package, then backend dependencies from lock file.
# --prefix=/install collects everything into a relocatable tree.
COPY backend/requirements.lock /build/requirements.lock
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --prefix=/install /engine && \
    pip install --no-cache-dir --prefix=/install -r /build/requirements.lock

# ── Stage 2: Runtime ────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install only the runtime system libraries (no compilers)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        postgresql-client \
        curl \
        libjpeg62-turbo \
        libwebp7 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Copy the pre-built Python packages from the builder stage
COPY --from=builder /install /usr/local

# Copy backend application code (build context is repository root)
COPY backend/ /app

RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser --ingroup appgroup
USER appuser

EXPOSE 8000

# API(uvicorn) 전용 헬스체크. celery-beat/worker 는 이 이미지를 공유하지만 HTTP 서버가
# 없으므로 이 체크를 상속하면 항상 실패한다 → 오케스트레이터에서 앱별로 덮어써야 한다:
#   - AWS ECS : task-definitions/celery-*.json (beat=null, worker=celery inspect ping)
#   - CapRover: infra/caprover/celery/ (serviceUpdateOverride 로 교정)
# 여기서 이 HEALTHCHECK 를 제거하면 API 헬스체크가 사라지니 삭제 금지.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/health/live || exit 1

# Run migrations then start uvicorn
CMD ["bash", "start.sh"]
