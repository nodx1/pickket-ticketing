# SECURITY: pin base image to a SHA256 digest for reproducible builds.
#   FROM node:20-alpine@sha256:<digest> AS base
# Digest pinning DEFERRED — fetch online (docker manifest inspect node:20-alpine)
# and refresh via Renovate/Dependabot. Pin before launch.
# renovate: datasource=docker depName=node
FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/consumer/package.json ./apps/consumer/
COPY packages/lib/package.json ./packages/lib/
COPY packages/ui/package.json ./packages/ui/
COPY packages/store/package.json ./packages/store/
COPY packages/tailwind-config/package.json ./packages/tailwind-config/
RUN pnpm install --frozen-lockfile

FROM base AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/consumer/node_modules ./apps/consumer/node_modules
COPY --from=deps /app/packages/ ./packages/
# NOTE: `COPY . .` scope is governed by /.dockerignore (excludes .env*, .git, node_modules, etc).
# Keep .dockerignore current so secrets/build artifacts never enter the image layer.
COPY . .

ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_BASE_URL=
ARG NEXT_PUBLIC_GO_URL=
ARG NEXT_PUBLIC_PICKKET_GO_URL=
ARG NEXT_PUBLIC_CONSUMER_URL=
ARG NEXT_PUBLIC_CDN_URL=
ARG NEXT_PUBLIC_WS_URL=
ARG NEXT_PUBLIC_PORTONE_STORE_ID=
ARG NEXT_PUBLIC_PORTONE_CHANNEL_KEY=
ARG NEXT_PUBLIC_PORTONE_MOCK_MODE=false
ARG CDN_URL=
ARG BUILD_TARGET=development
ARG NEXT_DEPLOYMENT_ID=""
ARG NEXT_PUBLIC_QUEUE_ENABLED=true
# PORTONE_LIVE=true 일 때만 PortOne 스토어/채널 키가 빌드 타임 필수.
# staging/dev 는 PORTONE_MOCK_MODE 로 돌아가므로 기본값 false.
ARG PORTONE_LIVE=false
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_QUEUE_ENABLED=${NEXT_PUBLIC_QUEUE_ENABLED}
ENV NEXT_PUBLIC_BASE_URL=${NEXT_PUBLIC_BASE_URL}
ENV NEXT_PUBLIC_GO_URL=${NEXT_PUBLIC_GO_URL}
ENV NEXT_PUBLIC_PICKKET_GO_URL=${NEXT_PUBLIC_PICKKET_GO_URL}
ENV NEXT_PUBLIC_CONSUMER_URL=${NEXT_PUBLIC_CONSUMER_URL}
ENV NEXT_PUBLIC_CDN_URL=${NEXT_PUBLIC_CDN_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_PORTONE_STORE_ID=${NEXT_PUBLIC_PORTONE_STORE_ID}
ENV NEXT_PUBLIC_PORTONE_CHANNEL_KEY=${NEXT_PUBLIC_PORTONE_CHANNEL_KEY}
ENV NEXT_PUBLIC_PORTONE_MOCK_MODE=${NEXT_PUBLIC_PORTONE_MOCK_MODE}
ENV CDN_URL=${CDN_URL}
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}

# 프로덕션 빌드 시 필수 URL 누락 또는 localhost 방지 + PortOne 키 필수 (AUDIT §P0)
RUN if [ "$BUILD_TARGET" != "development" ]; then \
      for var in NEXT_PUBLIC_API_URL NEXT_PUBLIC_BASE_URL; do \
        eval val=\$$var; \
        if [ -z "$val" ] || echo "$val" | grep -q "localhost"; then \
          echo "FATAL: $var must be a real URL for $BUILD_TARGET (got: '$val')" && exit 1; \
        fi; \
      done; \
      if [ "${PORTONE_LIVE:-false}" = "true" ]; then \
        for var in NEXT_PUBLIC_PORTONE_STORE_ID NEXT_PUBLIC_PORTONE_CHANNEL_KEY; do \
          eval val=\$$var; \
          if [ -z "$val" ]; then \
            echo "FATAL: $var is required when PORTONE_LIVE=true" && exit 1; \
          fi; \
        done; \
      fi; \
    fi

# SW 캐시 버전을 빌드 해시로 교체 (배포 시 이전 캐시 자동 삭제)
RUN BUILD_HASH=$(date +%s | md5sum | head -c 8) && \
    sed -i "s/__BUILD_HASH__/${BUILD_HASH}/g" apps/consumer/public/sw.js

RUN pnpm --filter @pickket/consumer build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ARG NEXT_DEPLOYMENT_ID=""
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/consumer/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/consumer/public ./apps/consumer/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/consumer/.next/static ./apps/consumer/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000 || exit 1

CMD ["node", "apps/consumer/server.js"]
