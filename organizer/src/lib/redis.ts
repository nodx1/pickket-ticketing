import IORedis from "ioredis";

declare global {
  var __pickketRedis: IORedis | undefined;
  var __pickketRedisPrefixed: IORedis | undefined;
}

/**
 * Redis DB 번호 선택.
 * - v2 클러스터 공유 시: DB 3 권장 (v2는 0/1/2 사용)
 * - 로컬/단독: 0 (기본)
 *
 * 환경변수 REDIS_DB 로 조정 가능. REDIS_URL에 `/<db>` path가 있으면 그것이 우선.
 */
function parseRedisDb(): number | undefined {
  const raw = process.env.REDIS_DB;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 15 ? n : undefined;
}

/**
 * BullMQ 전용 Redis 클라이언트.
 *
 * 주의: BullMQ는 `keyPrefix` 옵션과 충돌함 (BullMQ가 자체 prefix 체계 사용).
 * `keyPrefix` 없이 생성하고, BullMQ `createQueue`/`createWorker`에서 별도로 `prefix: "go"` 주입.
 */
export function getRedis(): IORedis {
  if (!globalThis.__pickketRedis) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const db = parseRedisDb();
    globalThis.__pickketRedis = new IORedis(url, {
      maxRetriesPerRequest: null, // BullMQ 권장 설정
      lazyConnect: true,
      ...(db !== undefined ? { db } : {}),
    });
    globalThis.__pickketRedis.connect().catch(() => {});
  }
  return globalThis.__pickketRedis;
}

/**
 * 비-BullMQ 용도 Redis 클라이언트 (rate limit / webhook idempotency / bot shield / fraud detector).
 *
 * `keyPrefix: "go:"` 로 전역 네임스페이스 분리. v2 Celery/캐시와 충돌 없음.
 * v2 키 패턴: `cache:*`, `rate_limit:*`, `auth_user:*` (prefix 없음)
 * go 키 패턴: `go:auth:ip:*`, `go:webhook:*`, `go:otp:*` 등
 */
export function getPrefixedRedis(): IORedis {
  if (!globalThis.__pickketRedisPrefixed) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const db = parseRedisDb();
    globalThis.__pickketRedisPrefixed = new IORedis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keyPrefix: "go:",
      ...(db !== undefined ? { db } : {}),
    });
    globalThis.__pickketRedisPrefixed.connect().catch(() => {});
  }
  return globalThis.__pickketRedisPrefixed;
}
