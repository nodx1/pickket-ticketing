/**
 * Readiness probe — 실제 트래픽 처리 가능한지 확인.
 *
 * 외부 의존성 체크:
 *  - DB: SELECT 1 (1초 타임아웃)
 *  - Redis: PING (500ms 타임아웃)
 *  - RISE 엔진: GET /health (1초 타임아웃, 설정돼 있을 때만)
 *
 * 전부 OK → 200, 하나라도 실패 → 503 + 상세.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { getRedis } from "@/lib/redis";
import { getBuildInfo } from "@/lib/build-info";

interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Schema migrations required before this process may receive traffic. */
export const HARD_REQUIRED_SCHEMA_MIGRATIONS = [
  "224-payment-confirm-outbox.sql",
  "226-audit-outbox.sql",
  "227-compensation-seat-expiry-projection.sql",
  "228-ops-cron-runs-degraded.sql",
  "229-waitlist-claim-recovery.sql",
  "230-compensation-provider-anchored.sql",
  "231-payment-attempts-ledger.sql",
  "232-payment-compensation-attempt-idempotency.sql",
] as const;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 타임아웃 (${timeoutMs}ms)`)), timeoutMs),
    ),
  ]);
}

async function checkDb(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const pool = getPool();
    await withTimeout(pool.query("SELECT 1"), 1000, "DB");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkSchema(): Promise<CheckResult> {
  const start = Date.now();
  // 필수 스키마 게이트. 224·226~232는 현재 복구·감사·Toss 결제 경로가 직접 사용하는 hard requirement다.
  // 225는 go 고유 폐기군 DROP-only 마이그레이션이라 런타임 SQL 계약에는 필요하지 않아 제외한다.
  // 하나라도 빠진 상태에서 readiness=200이면 요청 처리 중 SQL 오류로 복구 원장이 유실될 수 있다.
  const configured = process.env.REQUIRED_SCHEMA_MIGRATION ?? "207-provider-reconciliation-identifiers.sql";
  const required = Array.from(new Set([configured, ...HARD_REQUIRED_SCHEMA_MIGRATIONS]));
  try {
    const pool = getPool();
    const result = await withTimeout(
      pool.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations WHERE filename = ANY($1)",
        [required],
      ),
      1000,
      "schema",
    );
    const applied = new Set(result.rows.map((r) => r.filename));
    const missing = required.filter((f) => !applied.has(f));
    if (missing.length > 0) {
      return { ok: false, latencyMs: Date.now() - start, error: `필수 스키마 미적용: ${missing.join(", ")}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const redis = getRedis();
    await withTimeout(redis.ping(), 500, "Redis");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRise(): Promise<CheckResult | null> {
  const url = process.env.RISE_ENGINE_URL;
  if (!url) return null; // RISE 설정 안 됐으면 스킵
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: `HTTP ${response.status}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const [db, schema, redis, rise] = await Promise.all([checkDb(), checkSchema(), checkRedis(), checkRise()]);

  const checks: Record<string, CheckResult> = { db, schema, redis };
  if (rise !== null) checks.rise = rise;

  // RISE는 선택적 서비스 (스테이징에 없을 수 있음) — DB/Redis만 필수
  const coreOk = db.ok && schema.ok && redis.ok;
  const status = coreOk ? 200 : 503;

  return NextResponse.json(
    {
      status: coreOk ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      // 🔴 실행 중인 배포 커밋. 인증 없이 확인 가능해야 한다 — "prod 에 지금 무엇이
      //    돌고 있나" 를 동작 탐침으로 역추적하다 두 세션이 서로의 배포를 오인했다
      //    (2026-07-29). 짧은 sha 만 노출한다.
      build: getBuildInfo(),
      checks,
    },
    { status },
  );
}
