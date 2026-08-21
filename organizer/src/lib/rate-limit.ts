/**
 * Rate limiting — Redis ZSET sliding window.
 *
 * v2 패턴 참조: backend/app/middleware/rate_limit.py
 *
 * - Redis ZSET 기반 sliding window (Lua 원자 실행)
 * - Redis 불가 시 in-memory Map으로 fallback
 * - 프리셋 리미터 이름/한도는 v2와 맞춤
 */
import type IORedis from "ioredis";
import { getPrefixedRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

// ───────────────────────── 타입 ─────────────────────────

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Redis 장애 시 동작:
   *  - "open": 요청 통과 (warn log), auth/upload/general 용도
   *  - "closed": 429 반환, webhook/payment 용도
   * 기본: "open"
   */
  onRedisError?: "open" | "closed";
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  /** 리미트 총 한도 (헤더용) */
  limit: number;
}

// ───────────────────────── 프리셋 (v2와 동일 이름/한도) ─────────────────────────

export const RATE_LIMIT_PRESETS = {
  auth: { windowMs: 60_000, max: 5, onRedisError: "open" as const },
  payment: { windowMs: 60_000, max: 10, onRedisError: "closed" as const },
  sms: { windowMs: 60_000, max: 3, onRedisError: "closed" as const },
  purchase_user: { windowMs: 60_000, max: 10, onRedisError: "closed" as const },
  checkin: { windowMs: 60_000, max: 100, onRedisError: "open" as const },
  webhook: { windowMs: 60_000, max: 100, onRedisError: "closed" as const },
  password_reset: { windowMs: 3_600_000, max: 3, onRedisError: "open" as const },
  upload: { windowMs: 3_600_000, max: 100, onRedisError: "open" as const },
  bid: { windowMs: 60_000, max: 10, onRedisError: "closed" as const },
  general: { windowMs: 60_000, max: 300, onRedisError: "open" as const },
} as const;

export type RateLimitPreset = keyof typeof RATE_LIMIT_PRESETS;

// ───────────────────────── Lua script (atomic sliding window) ─────────────────────────

/**
 * KEYS[1] = bucket key
 * ARGV[1] = window start ms (cutoff, exclusive)
 * ARGV[2] = now ms
 * ARGV[3] = max
 * ARGV[4] = member (unique request id)
 * ARGV[5] = window ms (for EXPIRE)
 *
 * Returns: { allowed(0|1), count, resetAtMs }
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local cutoff = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
local windowMs = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)

if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = now + windowMs
  if oldest[2] then
    resetAt = tonumber(oldest[2]) + windowMs
  end
  return {0, count, resetAt}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs + 1000)
return {1, count + 1, now + windowMs}
`.trim();

// ───────────────────────── In-memory fallback ─────────────────────────

interface MemEntry {
  count: number;
  resetAt: number;
}
const memStore = new Map<string, MemEntry>();

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memStore) {
      if (entry.resetAt < now) memStore.delete(key);
    }
  }, 300_000);
}

function checkInMemory(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const entry = memStore.get(key);
  if (!entry || entry.resetAt < now) {
    const resetAt = now + options.windowMs;
    memStore.set(key, { count: 1, resetAt });
    return { success: true, remaining: options.max - 1, resetAt, limit: options.max };
  }
  entry.count += 1;
  if (entry.count > options.max) {
    return { success: false, remaining: 0, resetAt: entry.resetAt, limit: options.max };
  }
  return {
    success: true,
    remaining: options.max - entry.count,
    resetAt: entry.resetAt,
    limit: options.max,
  };
}

// ───────────────────────── Main ─────────────────────────

let redisOnce: IORedis | null | undefined;

function tryGetRedis(): IORedis | null {
  if (redisOnce !== undefined) return redisOnce;
  try {
    redisOnce = getPrefixedRedis();
    return redisOnce;
  } catch {
    redisOnce = null;
    return null;
  }
}

/**
 * Rate limit 체크 (async).
 *
 * @param key — 버킷 키 (예: `auth:ip:1.2.3.4`)
 * @param options — windowMs + max + onRedisError
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const redis = tryGetRedis();
  if (!redis) {
    return checkInMemory(key, options);
  }

  const now = Date.now();
  const cutoff = now - options.windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

  try {
    const raw = (await redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(cutoff),
      String(now),
      String(options.max),
      member,
      String(options.windowMs),
    )) as [number, number, number];

    const [allowed, count, resetAtMs] = raw;
    const success = allowed === 1;
    return {
      success,
      remaining: Math.max(0, options.max - count),
      resetAt: resetAtMs,
      limit: options.max,
    };
  } catch (err) {
    const mode = options.onRedisError ?? "open";
    logger.warn("rate-limit: Redis 실패", {
      key,
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
    if (mode === "closed") {
      return { success: false, remaining: 0, resetAt: now + options.windowMs, limit: options.max };
    }
    // fail-open → in-memory로 폴백
    return checkInMemory(key, options);
  }
}

/**
 * 프리셋 기반 rate limit 체크.
 */
export async function checkRateLimitPreset(
  key: string,
  preset: RateLimitPreset,
): Promise<RateLimitResult> {
  return checkRateLimit(key, RATE_LIMIT_PRESETS[preset]);
}
