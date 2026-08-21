# syntax=docker/dockerfile:1.7
# PICKKET.GO Next.js 16 프로덕션 이미지
#
# Multistage: deps → builder → runner
# Base: node:22-bookworm-slim (sharp + @react-pdf/renderer native deps 호환)
# Output: Next.js standalone 모드 (next.config.ts에 output:'standalone' 필요)

# ───────────────────────── deps ─────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# sharp + @react-pdf/renderer 빌드용 native deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config libc6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# lock 파일이 있으면 ci, 없으면 install
# npm ci는 package-lock.json이 package.json과 정확히 동기화돼야만 동작한다.
# 홈서버 CapRover 배포에선 lock 드리프트가 있어 npm install로 완화(설치 시 lock 갱신).
RUN npm install --no-audit --no-fund

# ───────────────────────── builder ─────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js `NEXT_PUBLIC_*` 는 빌드 타임에 클라이언트 번들에 인라인됨.
# staging/prod 이미지를 분리하려면 build arg로 주입해야 함.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3003
ARG NEXT_PUBLIC_V2_API_URL=
# 비워두면 public-footer.tsx 의 코드 기본값(주식회사 노드엑스·곽민철·주소)이 적용됨.
# 값을 넣으려면 배포 시 --build-arg 로 주입(코드는 `||` 라 비었을 때만 폴백).
ARG NEXT_PUBLIC_COMPANY_NAME=""
ARG NEXT_PUBLIC_COMPANY_ADDRESS=""
ARG NEXT_PUBLIC_CONTACT_EMAIL=""
ARG NEXT_PUBLIC_OWNER_NAME=""
ARG NEXT_PUBLIC_BUSINESS_NUMBER=""
ARG NEXT_PUBLIC_ECOMMERCE_NUMBER=""
ARG NEXT_PUBLIC_BANK_NAME=""
ARG NEXT_PUBLIC_BANK_ACCOUNT=""
ARG NEXT_PUBLIC_BANK_HOLDER=""

ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_V2_API_URL=${NEXT_PUBLIC_V2_API_URL}
ENV NEXT_PUBLIC_COMPANY_NAME=${NEXT_PUBLIC_COMPANY_NAME}
ENV NEXT_PUBLIC_COMPANY_ADDRESS=${NEXT_PUBLIC_COMPANY_ADDRESS}
ENV NEXT_PUBLIC_CONTACT_EMAIL=${NEXT_PUBLIC_CONTACT_EMAIL}
ENV NEXT_PUBLIC_OWNER_NAME=${NEXT_PUBLIC_OWNER_NAME}
ENV NEXT_PUBLIC_BUSINESS_NUMBER=${NEXT_PUBLIC_BUSINESS_NUMBER}
ENV NEXT_PUBLIC_ECOMMERCE_NUMBER=${NEXT_PUBLIC_ECOMMERCE_NUMBER}
ENV NEXT_PUBLIC_BANK_NAME=${NEXT_PUBLIC_BANK_NAME}
ENV NEXT_PUBLIC_BANK_ACCOUNT=${NEXT_PUBLIC_BANK_ACCOUNT}
ENV NEXT_PUBLIC_BANK_HOLDER=${NEXT_PUBLIC_BANK_HOLDER}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 🔴 배포 커밋 표식 — deploy-app.sh 가 타르볼에 심는다. 로컬 빌드엔 없으므로 기본값을 만든다.
#    이 파일이 런타임 이미지까지 따라가야 "prod 에 지금 무엇이 돌고 있나" 를 알 수 있다.
RUN [ -f .build-info.json ] || echo '{"commit":"unknown","app":"local","builtAt":""}' > .build-info.json

# 빌드 (런타임 전용 시크릿은 더미로, NEXT_PUBLIC_*만 주입되면 됨)
ENV NODE_ENV=production
RUN npm run build

# ───────────────────────── runner ─────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3003
ENV HOSTNAME=0.0.0.0

# 런타임 native libs (sharp image processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dumb-init libvips42 \
    && rm -rf /var/lib/apt/lists/*

# nextjs user (non-root)
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m -s /bin/bash nextjs

# standalone 빌드 산출물 복사
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 마이그레이션/시드용 소스 + 의존성 (one-off ECS task로 실행)
# standalone output에는 src/ 소스와 전체 node_modules가 빠져있으므로 별도 복사 필요.
# seed.ts → @/lib/auth/password, migrate.ts → @/lib/db/pool → @/lib/logger 등
# 개별 파일 추적 대신 src/lib 전체 복사 — 향후 의존성 추가에도 안전.
COPY --from=builder --chown=nextjs:nodejs /app/.build-info.json ./.build-info.json
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src/lib ./src/lib
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/start.sh ./start.sh

USER nextjs

EXPOSE 3003

# 헬스체크: /api/health/live (프로세스 생존만 확인, 외부 의존성 체크 없음)
# /api/health/ready는 DB+Redis+RISE를 체크하므로 RISE 없는 스테이징에서 unhealthy 판정 →
# ECS task 재시작 반복 → 서비스 불안정. liveness는 프로세스만 보고, readiness는 ALB가 별도 확인.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:3003/api/health/live').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# Application startup is deliberately migration-free. The ECS deploy workflow
# runs `npx tsx scripts/migrate.ts` as a one-off task before updating the service.
CMD ["bash", "start.sh"]
