/**
 * v2 admin → go: 이벤트 심사 결과 수신 webhook.
 *
 * v2 admin 이 승인/반려 버튼 누르면 이 엔드포인트 호출됨.
 * go 는 이벤트 상태를 live/rejected 로 전환하고 주최자에게 알린다.
 *
 * 인증: HMAC-SHA256 서명 (V2_EVENT_SYNC_SECRET 공유 시크릿)
 *
 * Payload:
 *   {
 *     action: "approved" | "rejected",
 *     reason?: string,
 *     reviewerId: string,
 *     reviewedAt: string  // ISO timestamp
 *   }
 *
 * ## 레벨2 컷오버 W2-EVT
 * 상태 정본이 go `events` → v2 로 완전히 옮겨졌다. 그래서 순서가 **뒤집혔다**:
 *   (옛) go 트랜잭션 COMMIT → v2 write-through   ← go=live / v2=pending 발산 가능
 *   (현) v2 상태 전이 확정 → go 부수효과(감사 로그·신뢰도·알림) best-effort
 * v2 write 가 실패하면 아무 상태도 바뀌지 않은 것이므로 502(retryable)로 응답해 v2 재배달을 유도한다.
 *
 * ## 레벨2 컷오버 W5-SUPPORT
 * `event_reviews` → v2 `event_publication_reviews`, `notifications` → v2
 * `organizer_notifications` 로 이관 완료. 부수효과는 여전히 best-effort(전이 확정 후)다.
 * 🔴 잔여(범위 밖 의존): `accounts.trust_score` — 계정 테이블 이관은 별도 트랙 소유.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db/pool";
import { verifyV2Webhook } from "@/lib/v2/webhook-verify";
import { canTransition, type EventStatus } from "@/lib/events/status-machine";
import { goToV2WriteEventStatus } from "@/lib/domain-model";
import {
  createOrganizerNotification,
  getEvent,
  goAccountRef,
  recordPublicationReview,
  updateEvent,
  type EventDetail,
  type EventWriteInput,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { ensureWebhookOnce, markWebhookResult } from "@/lib/webhook/idempotency";
import { logger } from "@/lib/logger";

const schema = z.object({
  action: z.enum(["approved", "rejected"]),
  reason: z.string().max(2000).optional(),
  reviewerId: z.string().min(1),
  // offset: true 로 +00:00 포맷도 허용 (python isoformat 호환)
  reviewedAt: z.string().datetime({ offset: true }).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/** 승인/반려 후 go 부수효과(감사 이력·신뢰도·알림). 실패해도 상태 전이는 이미 확정. */
async function recordSideEffects(
  eventId: string,
  accountId: string | null,
  title: string,
  action: "approved" | "rejected",
  reason: string | undefined,
  reviewerId: string,
  reviewedAt: string | undefined,
): Promise<void> {
  const pool = getPool();

  // ── W5-SUPPORT: go `event_reviews` → v2 `event_publication_reviews`. ──
  // 🔴 organizer_ref 를 **넘기지 않는다** — 이 경로는 v2 admin 발신이라 organizer 스코프가
  //    없다. v2 는 이 경우 이벤트 존재만 확인한다(엔드포인트 자체가 내부 서비스 인증 뒤).
  await recordPublicationReview(eventId, {
    action: action === "approved" ? "approve" : "reject",
    reason: reason ?? null,
    checklist: { reviewer: reviewerId, reviewed_at: reviewedAt },
    reviewer_ref: reviewerId,
  }).catch((err: unknown) => {
    logger.warn("게시 심사 이력 기록 실패 (무시)", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
  });

  if (!accountId) {
    logger.warn("심사 결과 부수효과 일부 생략: go_account_id 미해석", { eventId });
    return;
  }

  // 승인 시 주최자 신뢰도 +10 (verified 승격 임계 50, premium 임계 100)
  if (action === "approved") {
    await pool
      .query(
        `UPDATE accounts
         SET trust_score = trust_score + 10,
             trust_tier = CASE
               WHEN trust_score + 10 >= 100 THEN 'premium'
               WHEN trust_score + 10 >= 50 THEN 'verified'
               ELSE trust_tier
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [accountId],
      )
      .catch((err: Error) => {
        logger.warn("trust_score 갱신 실패 (무시)", { accountId, error: err.message });
      });
  }

  // ── W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
  // ⚠️ type `event_approved`/`event_rejected` 는 go 146 이 허용했던 값인데 v2 흡수 시
  //    CHECK 에서 누락돼 있었다 → w5sup_0727 에서 다시 넓혔다(안 넓히면 무음 유실).
  await createOrganizerNotification({
    account_id: accountId,
    event_id: eventId,
    type: action === "approved" ? "event_approved" : "event_rejected",
    title: action === "approved" ? "이벤트 승인" : "이벤트 반려",
    message:
      action === "approved"
        ? `🎉 "${title}" 가 승인되어 공개되었습니다.`
        : `📝 "${title}" 심사 결과 수정이 필요합니다. 사유: ${reason ?? ""}`,
    metadata: { action, reason, reviewerId },
  }).catch((err: unknown) => {
    logger.warn("주최자 알림 기록 실패 (무시)", {
      error: err instanceof Error ? err.message : "unknown",
    });
  });
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { eventId } = await context.params;
  const rawBody = await request.text();

  // HMAC 검증
  const verify = await verifyV2Webhook(request, rawBody);
  if (!verify.ok) {
    logger.warn("v2 webhook 서명 검증 실패", { eventId, error: verify.error });
    return NextResponse.json({ error: verify.error ?? "unauthorized" }, { status: 401 });
  }

  // eventName 바인딩 — 공유 시크릿(V2_EVENT_SYNC_SECRET)으로 서명된 다른 용도(fcfs 등)
  // webhook 이 이 엔드포인트로 흘러들어와 이벤트를 live 승격시키는 것을 차단.
  if (verify.eventName && !verify.eventName.startsWith("event.review")) {
    logger.warn("review-result 에 예상치 못한 이벤트명", { eventId, eventName: verify.eventName });
    return NextResponse.json({ error: "unexpected event" }, { status: 400 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(JSON.parse(rawBody));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid payload" },
      { status: 400 },
    );
  }

  const once = await ensureWebhookOnce({
    provider: "v2",
    rawBody,
    parsedPayload: body,
    eventId: verify.deliveryId,
    timestamp: verify.timestamp,
  });
  if (once.kind === "duplicate") {
    logger.info("v2 webhook 중복 delivery 무시", {
      eventId,
      deliveryId: once.eventId,
      reason: once.reason,
    });
    return NextResponse.json({ ok: true, duplicate: true, eventId });
  }
  if (once.kind === "expired") {
    return NextResponse.json(
      { error: "expired webhook", skewSeconds: once.skewSeconds },
      { status: 401 },
    );
  }

  // ── 현재 상태 read (v2 정본). 이 webhook 은 admin 발신이라 organizer_ref 스코프가 없다. ──
  let current: EventDetail;
  try {
    current = await getEvent(eventId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) {
        await markWebhookResult(once.dbRowId, "error", "event not found");
        return NextResponse.json({ error: "이벤트 없음" }, { status: 404 });
      }
      // 🔴 조회 실패를 "이벤트 없음(404)"으로 뭉개면 v2 가 재배달을 포기한다 → 502 retryable.
      await markWebhookResult(once.dbRowId, "error", `이벤트 조회 실패: ${err.message}`);
      return NextResponse.json(
        { error: "커머스 조회에 실패했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
        { status: 502 },
      );
    }
    throw err;
  }

  const currentStatus = current.status as EventStatus;
  const accountId = current.go_account_id ?? null;
  const nextStatus: EventStatus = body.action === "approved" ? "live" : "rejected";

  if (currentStatus === nextStatus) {
    // 이미 목표 상태 — 멱등 no-op. 상태 전이 자체가 v2 write 이므로 추가 수렴 호출이 불필요하다.
    await markWebhookResult(once.dbRowId, "ok");
    logger.info("v2 webhook 심사 결과 no-op", {
      eventId,
      action: body.action,
      status: currentStatus,
    });
    return NextResponse.json({ ok: true, eventId, status: nextStatus, idempotent: true });
  }

  if (!canTransition(currentStatus, nextStatus, "admin")) {
    await markWebhookResult(
      once.dbRowId,
      "error",
      `${currentStatus} -> ${nextStatus} transition forbidden`,
    );
    return NextResponse.json(
      { error: `${currentStatus} → ${nextStatus} 전이 불가`, currentStatus },
      { status: 409 },
    );
  }

  // ── 상태 전이 = v2 write (유일한 정본 변경). 실패 시 502 로 v2 재배달 유도. ──
  // status 는 go 어휘 → v2 매핑(live→approved, rejected→revision_requested).
  const v2Status = goToV2WriteEventStatus(nextStatus);
  const patch: Partial<Omit<EventWriteInput, "external_ref">> = {
    ...(accountId ? { organizer_ref: goAccountRef(accountId) } : {}),
    ...(v2Status ? { status: v2Status } : {}),
  };
  try {
    await updateEvent(eventId, patch, { idempotencyKey: `event-${body.action}:${eventId}` });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      await markWebhookResult(once.dbRowId, "error", `v2 status sync 실패: ${err.message}`);
      logger.warn("v2 webhook 심사 결과 반영 실패 — v2 재시도 유도", {
        eventId,
        status: err.status,
      });
      return NextResponse.json(
        { error: "커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
        { status: 502 },
      );
    }
    throw err;
  }

  await markWebhookResult(once.dbRowId, "ok");

  // 부수효과(감사 이력·신뢰도·주최자 알림) — 상태 전이 확정 후. 실패해도 전이는 되돌리지 않는다.
  await recordSideEffects(
    eventId,
    accountId,
    current.title,
    body.action,
    body.reason,
    body.reviewerId,
    body.reviewedAt,
  );

  logger.info("v2 webhook 심사 결과 처리 완료", {
    eventId,
    action: body.action,
    reviewer: body.reviewerId,
    nextStatus,
  });

  return NextResponse.json({ ok: true, eventId, status: nextStatus });
}
