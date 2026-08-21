/**
 * PostgreSQL 커넥션 풀 — v2 동등 수준 강화 (2026-04-07)
 *
 * 타임아웃 3종: statement_timeout / lock_timeout / idle_in_transaction_session_timeout
 * 풀 강화: connectionTimeoutMillis / application_name / 주기 로깅
 * SSL: PG_SSL=true 시 활성화
 */
import { Pool, type PoolConfig } from "pg";
import { logger } from "@/lib/logger";

declare global {
  var __pickketPool: Pool | undefined;
  var __pickketPoolHandlersRegistered: boolean | undefined;
  var __pickketPoolMonitorInterval: ReturnType<typeof setInterval> | undefined;
}

function getPoolConfig(): PoolConfig {
  const port = Number(process.env.PG_PORT ?? "5432");
  const max = Number(process.env.PG_POOL_MAX ?? "20");

  const config: PoolConfig = {
    host: process.env.PG_HOST,
    port: Number.isNaN(port) ? 5432 : port,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    max: Number.isNaN(max) ? 20 : max,
    idleTimeoutMillis: 30_000,
    // Phase 2: 커넥션 획득 타임아웃 — 풀 소진 시 무한 대기 방지
    connectionTimeoutMillis: 10_000,
    // Phase 2: Aurora 모니터링에서 go vs v2 식별
    application_name: "pickket-go",
    // 서버 세션 옵션으로 설정해 connect 이벤트의 추가 쿼리를 제거한다.
    options: "-c statement_timeout=12s -c lock_timeout=5s -c idle_in_transaction_session_timeout=10s",
  };

  // Phase 5: SSL 연결 (PG_SSL=true 시)
  if (process.env.PG_SSL === "true") {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function registerShutdownHandlers(pool: Pool) {
  if (globalThis.__pickketPoolHandlersRegistered) {
    return;
  }

  const closePool = async () => {
    if (globalThis.__pickketPoolMonitorInterval) {
      clearInterval(globalThis.__pickketPoolMonitorInterval);
    }
    await pool.end().catch(() => undefined);
  };

  process.once("beforeExit", closePool);
  process.once("SIGINT", () => {
    void closePool();
  });
  process.once("SIGTERM", () => {
    void closePool();
  });

  globalThis.__pickketPoolHandlersRegistered = true;
}

function registerPoolObservers(pool: Pool) {
  pool.on("error", (err: Error) => {
    logger.error("DB 풀 오류", {
      source: "db-pool",
      error: err.message,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    });
  });

  pool.on("acquire", () => {
    if (pool.waitingCount > 0 || process.env.LOG_LEVEL === "debug") {
      logger.debug("DB 풀 상태", {
        source: "db-pool",
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      });
    }
  });

  // Phase 2: 1분마다 풀 상태 로깅 (운영 모니터링)
  if (!globalThis.__pickketPoolMonitorInterval) {
    globalThis.__pickketPoolMonitorInterval = setInterval(() => {
      if (pool.totalCount > 0 || pool.waitingCount > 0) {
        logger.info("DB 풀 모니터", {
          source: "db-pool",
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        });
      }
    }, 60_000);
    // unref로 프로세스 종료 방해 안 하게
    if (globalThis.__pickketPoolMonitorInterval.unref) {
      globalThis.__pickketPoolMonitorInterval.unref();
    }
  }
}

export function getPool() {
  if (!globalThis.__pickketPool) {
    globalThis.__pickketPool = new Pool(getPoolConfig());
    registerShutdownHandlers(globalThis.__pickketPool);
    registerPoolObservers(globalThis.__pickketPool);
  }

  return globalThis.__pickketPool;
}
