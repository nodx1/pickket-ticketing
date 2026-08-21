# SECURITY: pin base image to a SHA256 digest for reproducible builds.
#   FROM node:20-alpine@sha256:<digest> AS base
# Digest pinning DEFERRED — fetch online (docker manifest inspect node:20-alpine)
# and refresh via Renovate/Dependabot. Pin before launch.
# renovate: datasource=docker depName=node
FROM node:20-alpine AS base

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM base AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json ./apps/admin/
COPY packages/lib/package.json ./packages/lib/
COPY packages/ui/package.json ./packages/ui/
COPY packages/store/package.json ./packages/store/
COPY packages/tailwind-config/package.json ./packages/tailwind-config/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: Build the application
# ---------------------------------------------------------------------------
FROM base AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=deps /app/packages/ ./packages/
# NOTE: `COPY . .` scope is governed by /.dockerignore (excludes .env*, .git, node_modules, etc).
# Keep .dockerignore current so secrets/build artifacts never enter the image layer.
COPY . .

ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_BASE_URL=
ARG NEXT_PUBLIC_GO_URL=
ARG NEXT_PUBLIC_CONSUMER_URL=
ARG NEXT_PUBLIC_CDN_URL=
ARG NEXT_PUBLIC_WS_URL=
ARG BUILD_TARGET=development
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_BASE_URL=${NEXT_PUBLIC_BASE_URL}
ENV NEXT_PUBLIC_GO_URL=${NEXT_PUBLIC_GO_URL}
ENV NEXT_PUBLIC_CONSUMER_URL=${NEXT_PUBLIC_CONSUMER_URL}
ENV NEXT_PUBLIC_CDN_URL=${NEXT_PUBLIC_CDN_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

# 프로덕션 빌드 시 필수 URL 누락 또는 localhost 방지
RUN if [ "$BUILD_TARGET" != "development" ]; then \
      for var in NEXT_PUBLIC_API_URL NEXT_PUBLIC_BASE_URL; do \
        eval val=\$$var; \
        if [ -z "$val" ] || echo "$val" | grep -q "localhost"; then \
          echo "FATAL: $var must be a real URL for $BUILD_TARGET (got: '$val')" && exit 1; \
        fi; \
      done; \
    fi

# 코드베이스 스캔 → generated.json 갱신 (빌드 시 항상 최신 상태 유지)
RUN node scripts/generate-dashboard-data.mjs

RUN pnpm --filter @pickket/admin build

# ---------------------------------------------------------------------------
# Stage 3: Production runner (standalone output)
# ---------------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/public ./apps/admin/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/static ./apps/admin/.next/static

USER nextjs

EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/ || exit 1

CMD ["node", "apps/admin/server.js"]
