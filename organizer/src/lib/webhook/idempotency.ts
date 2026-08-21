/**
 * 결제 웹훅 idempotency 헬퍼.
 *
 * v2 패턴 참조: backend/app/api/v1/payment_webhook.py
 *
 * 구조:
 *   1. Event ID 추출: payload.id | eventId | event_id | sha256(raw body)
 *   2. Timestamp 검증: WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS (기본 60초)
 *   3. Redis NX SET 5분 TTL → 빠른 중복 차단 (없으면 skip)
 *   4. DB INSERT ON CONFLICT → 영구 감사 + 2차 방어
 *   5. handler 실행 후 result 'ok'/'error'로 UPDATE
 */
import crypto from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { getPrefixedRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const REDIS_TTL_SECONDS = 300; // 5분

export interface WebhookIdempotencyInput {
  provider: "toss" | "v2";
  rawBody: string;
  parsedPayload: Record<string, unknown>;
  /** 공급자가 제공한 고유 delivery/event id. 있으면 payload 추출보다 우선한다. */
  eventId?: string | null;
  /** 페이로드에 포함된 타임스탬프 (Unix epoch seconds 또는 ISO string). 없으면 검증 스킵. */
  timestamp?: number | string | null;
}

export type WebhookOnceResult =
  | { kind: "duplicate"; eventId: string; reason: "redis" | "db" }
  | { kind: "expired"; reason: "timestamp"; skewSeconds: number }
  | { kind: "fresh"; eventId: string; dbRowId: string };

/**
 * Event ID 추출 (v2와 동일 우선순위).
 */
function extractEventId(payload: Record<string, unknown>, rawBody: string): string {
  const candidates = ["id", "eventId", "event_id", "paymentKey", "orderId"] as const;
  for (const k of candidates) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // 폴백: sha256(body)
  return `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
}

/**
 * Timestamp 검증 — 웹훅 replay 방지.
 * 환경변수 WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS 초과 시 거부.
 */
function verifyTimestamp(
  ts: number | string | null | undefined,
  required: boolean,
): {
  ok: boolean;
  skewSeconds: number;
} {
  // required(결제 provider)일 때 ts 부재/파싱불가는 fail-closed. 이전엔 fail-open 이라
  // 타임스탬프 없는 재생(replay) 웹훅이 무제한 통과했다. (감사 P1-5)
  if (ts == null) return { ok: !required, skewSeconds: 0 };
  const tolerance = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS ?? 60);

  let epochSec: number;
  if (typeof ts === "number") {
    // 밀리초/초 둘 다 지원
    epochSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  } else {
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) return { ok: !required, skewSeconds: 0 };
    epochSec = Math.floor(parsed / 1000);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSec - epochSec);
  return { ok: skew <= tolerance, skewSeconds: skew };
}

// 결제 provider 는 타임스탬프를 반드시 보낸다 → 부재 시 fail-closed 로 replay 를 막는다.
const TIMESTAMP_REQUIRED_PROVIDERS = new Set(["toss"]);

/**
 * 웹훅 중복 방지 확인 + 초기 등록.
 *
 * 호출 후 `kind === "fresh"`면 handler를 실행하고, 완료되면
 * `markWebhookResult(dbRowId, 'ok' | 'error', errorMessage?)`를 호출한다.
 */
export async function ensureWebhookOnce(
  input: WebhookIdempotencyInput,
): Promise<WebhookOnceResult> {
  const eventId = input.eventId ?? extractEventId(input.parsedPayload, input.rawBody);

  // 1. Timestamp 검증 (결제 provider 는 ts 필수 = fail-closed)
  const tsCheck = verifyTimestamp(
    input.timestamp,
    TIMESTAMP_REQUIRED_PROVIDERS.has(input.provider),
  );
  if (!tsCheck.ok) {
    logger.warn("[webhook-idempotency] timestamp tolerance 초과", {
      provider: input.provider,
      eventId,
      skewSeconds: tsCheck.skewSeconds,
    });
    return { kind: "expired", reason: "timestamp", skewSeconds: tsCheck.skewSeconds };
  }

  // 2. Redis NX SET → 빠른 차단
  try {
    const redis = getPrefixedRedis();
    const key = `wh:${input.provider}:${eventId}`;
    const first = await redis.set(key, "1", "EX", REDIS_TTL_SECONDS, "NX");
    if (first !== "OK") {
      logger.info("[webhook-idempotency] Redis에서 중복 감지", {
        provider: input.provider,
        eventId,
      });
      return { kind: "duplicate", eventId, reason: "redis" };
    }
  } catch (err) {
    // Redis 장애 시에도 DB UNIQUE가 2차 방어. 경고만 남기고 진행.
    logger.warn("[webhook-idempotency] Redis 체크 실패, DB로 폴백", {
      provider: input.provider,
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. DB INSERT ON CONFLICT → 영구 감사 + 2차 방어
  //    성공(result='ok')한 이벤트만 '진짜 중복'으로 차단한다. 실패('error')·미완('processing')
  //    행은 재-오픈(processing 리셋)해 PG의 정당한 재배달을 fresh 로 재진입시킨다.
  //    ON CONFLICT DO NOTHING 이던 이전 코드는 첫 배달이 실패하면 그 행이 영구히 남아
  //    이후 모든 재시도를 중복으로 차단 → 결제확정이 영구 드롭됐다. 핸들러는 FOR UPDATE +
  //    상태머신으로 이미 멱등하므로 재처리는 안전하다. (감사 P0-3)
  const pool = getPool();
  const inserted = await pool.query<{ id: string }>(
    `
      INSERT INTO processed_webhook_events (provider, event_id, payload, result)
      VALUES ($1, $2, $3::jsonb, 'processing')
      ON CONFLICT (provider, event_id) DO UPDATE
        SET result = 'processing',
            payload = EXCLUDED.payload,
            error_message = NULL
      WHERE processed_webhook_events.result <> 'ok'
      RETURNING id
    `,
    [input.provider, eventId, JSON.stringify(input.parsedPayload)],
  );

  if (inserted.rows.length === 0) {
    logger.info("[webhook-idempotency] DB에서 중복 감지(성공 처리 완료된 이벤트)", {
      provider: input.provider,
      eventId,
    });
    return { kind: "duplicate", eventId, reason: "db" };
  }

  return { kind: "fresh", eventId, dbRowId: inserted.rows[0].id };
}

/**
 * handler 완료 후 결과 기록.
 */
export async function markWebhookResult(
  dbRowId: string,
  result: "ok" | "error",
  errorMessage?: string,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ provider: string; event_id: string }>(
    `
      UPDATE processed_webhook_events
      SET result = $2, error_message = $3
      WHERE id = $1
      RETURNING provider, event_id
    `,
    [dbRowId, result, errorMessage ?? null],
  );

  // 실패 시 Redis 빠른-차단 키를 즉시 해제한다. 그러지 않으면 PG 재배달이 5분 TTL 창 안에
  // Redis 중복으로 막혀 재처리가 지연된다. DB 행은 이미 non-ok 재진입을 허용한다. (감사 P0-3)
  if (result === "error" && rows[0]) {
    try {
      const redis = getPrefixedRedis();
      await redis.del(`wh:${rows[0].provider}:${rows[0].event_id}`);
    } catch (err) {
      logger.warn("[webhook-idempotency] 실패 행 Redis 키 해제 실패(무시 가능)", {
        dbRowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
