import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
// W5-MSG: event_messages 원장이 v2 로 이관됐다 — go DB SQL 0(목록·생성 모두 v2 경유).
import { ERR } from "@/lib/errors";
import { countRecipients, countSegment, type Segment } from "@/lib/notification/recipients";
import { deriveMessageType } from "@/lib/notification/message-purpose";
import {
  assertNoRetiredSegmentKeys,
  RetiredSegmentKeyError,
  segmentSchema,
} from "@/lib/notification/segment-schema";
import type { Channel } from "@/lib/notification/compliance";
import { createOrganizerMessage } from "@/lib/v2/commerce-client";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";
import { V2LotteryWonEntriesError } from "@/lib/v2/lottery-won-entries";
import { V2MessagingComplianceError } from "@/lib/v2/messaging-compliance-client";
import {
  ledgerErrorStatus,
  listEventMessages,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";
import { V2SegmentTicketsError } from "@/lib/v2/segment-tickets";
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";

type Params = { eventId: string };

// 세그먼트 타게팅 — 공용 화이트리스트 스키마(segment-schema). 없으면 recipientFilter(레거시) 사용.

const schema = z.object({
  title: z.string().min(2, "제목을 입력해주세요"),
  body: z.string().min(2, "본문을 입력해주세요"),
  channel: z.enum(["email", "sms", "alimtalk"]),
  recipientFilter: z.enum(["all", "checked_in", "not_checked_in"]).optional(),
  segment: segmentSchema.optional(),
  // §3-1: messageType 클라이언트 선택 제거. 발송 "목적"만 받고 서버가 유형을 강제(광고성 우회 차단).
  purpose: z.enum(["checkin", "notice", "reminder", "promotion", "sale"]).optional(),
  scheduledAt: z.string().optional(), // ISO — 미래면 예약(scheduled), 없으면 즉시 큐(queued)
  templateCode: z.string().optional(), // 알림톡 승인 템플릿 코드(kakao 배치 발송에 필요)
  dryRun: z.boolean().optional(),
});

const dryRunSchema = z.object({
  channel: z.enum(["email", "sms", "alimtalk"]),
  recipientFilter: z.enum(["all", "checked_in", "not_checked_in"]).optional(),
  segment: segmentSchema.optional(),
  dryRun: z.literal(true),
  title: z.string().optional(),
  body: z.string().optional(),
  purpose: z.enum(["checkin", "notice", "reminder", "promotion", "sale"]).optional(),
});

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  const status = new URL(request.url).searchParams.get("status");
  try {
    const rows = await listEventMessages(session.accountId, params.eventId, status);
    return listResponse(
      rows.map((m) => ({
        id: m.id,
        title: m.title,
        channel: m.channel,
        status: m.status,
        body: m.body,
        messageType: m.message_type,
        recipientFilter: m.recipient_filter,
        sentCount: m.sent_count,
        failedCount: m.failed_count,
        deliveredCount: m.delivered_count,
        openedCount: m.opened_count,
        clickedCount: m.clicked_count,
        scheduledAt: m.scheduled_at,
        sentAt: m.sent_at,
        createdAt: m.created_at,
      })),
      rows.length,
    );
  } catch (err: unknown) {
    // 🔴 fail-closed: 목록 조회 실패를 빈 배열로 흘리면 "발송 이력 없음"으로 보인다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    // L-02: 이벤트 소유검증 — 타 계정 event_id 를 참조하는 비정상 메시지 행 생성 방지.
    // W3-MSG: go `events` 조회 → v2 소유검증(테넌트 경계는 v2 organizer_ref 가 강제).
    if ((await getOwnedEvent(params.eventId, session.accountId)) === null) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    const raw = (await request.json()) as unknown;
    const maybeRaw = raw as Record<string, unknown>;
    // 폐기 세그먼트 키(crmTiers·crmTags)는 조용히 버리지 않고 거부한다 —
    // 좁히는 필터를 무시하면 의도보다 넓은 대상에게 발송된다.
    assertNoRetiredSegmentKeys(maybeRaw.segment);

    const countFor = (channel: "email" | "sms" | "alimtalk", segment: Segment | undefined, filter: "all" | "checked_in" | "not_checked_in" | undefined) =>
      segment
        ? countSegment(session.accountId, params.eventId, channel, segment)
        : countRecipients(session.accountId, params.eventId, channel, filter ?? "all");

    // dryRun: 수신자 수만 미리보기 (실발송과 동일 리졸버 사용 → 안내 수 == 실제 수, 수신거부·블랙리스트 제외됨)
    if (maybeRaw.dryRun === true) {
      const dryBody = dryRunSchema.parse(raw);
      const recipientCount = await countFor(dryBody.channel, dryBody.segment, dryBody.recipientFilter);
      return successResponse({ recipientCount });
    }

    const body = schema.parse(raw);

    // 예약 시각이 있으면 유효한 날짜여야 한다 — Invalid Date 가 조용히 즉시발송으로 폴백되던 버그 차단.
    let scheduledMs: number | null = null;
    if (body.scheduledAt !== undefined && body.scheduledAt !== "") {
      // 🔴 `new Date(naive)` 는 서버 시간대(UTC)로 해석한다 — 예약 발송이 9시간 밀린다.
      //    아래 저장(`scheduled_at`)과 **같은 함수**로 파싱해야 판정과 저장이 안 갈린다.
      const scheduledIso = toIsoFromKstLocal(body.scheduledAt);
      if (!scheduledIso) {
        return errorResponse("예약 시각 형식이 올바르지 않습니다", 400);
      }
      scheduledMs = new Date(scheduledIso).getTime();
    }

    // 동기 발송 루프 제거 — queued 로 저장하고 즉시 반환. dispatch-messages cron 이 실제 발송.
    // (이중발송·요청 타임아웃 해소. 수신자별 상태는 message_deliveries 에 기록.)
    // 2.6-Low4: 이메일/SMS 는 발송 목적을 반드시 골라야 유형 판정이 가능(광고성 우회 방지).
    // 알림톡은 목적과 무관하게 정보성 고정이라 미지정 허용.
    if (body.channel !== "alimtalk" && !body.purpose) {
      return errorResponse("발송 목적을 선택해주세요", 400);
    }

    const recipientCount = await countFor(body.channel, body.segment, body.recipientFilter);
    // §3-1: messageType 서버 강제 — 채널·목적으로 판정(본문 오버라이드 불가). 근거는 result_meta 에 감사기록.
    const chForType: Channel = body.channel === "alimtalk" ? "kakao" : body.channel;
    const { messageType, reason: messageTypeReason } = deriveMessageType(chForType, body.purpose);
    // 예약: scheduledAt 이 미래면 status='scheduled'(cron 이 시각 도달 시 발송). 아니면 'queued'(즉시).
    // 상태(scheduled|queued) 판정은 v2 가 scheduled_at 으로 재수행한다(단일 판정지점).
    const scheduledFuture = scheduledMs !== null && scheduledMs > Date.now();

    // W5-MSG: event_messages 원장은 v2 SoT 다 — **무조건** v2 로 큐잉한다(flag 조건부 아님).
    // 발송은 v2 Celery(dispatch_messages/dispatch_campaigns)가 단독 소유하므로 이중발송 0.
    //
    // 🔴 멱등키는 **안정 키**여야 한다. 매 호출 randomUUID 는 멱등이 아니다 —
    //   더블클릭/네트워크 재시도가 같은 메시지를 두 건 큐잉해 수신자에게 2회 나간다.
    //   (계정·이벤트·채널·제목·본문·예약시각) 지문으로 같은 요청을 같은 키에 묶는다.
    const idempotencyKey = createHash("sha256")
      .update(
        [
          session.accountId,
          params.eventId,
          body.channel,
          messageType,
          body.title,
          body.body,
          body.recipientFilter ?? "all",
          JSON.stringify(body.segment ?? null),
          body.templateCode ?? "",
          scheduledFuture ? toIsoFromKstLocal(body.scheduledAt as string) : "",
        ].join("\n"),
      )
      .digest("hex");

    const v2 = await createOrganizerMessage(
      {
        go_account_id: session.accountId,
        event_id: params.eventId,
        title: body.title,
        body: body.body,
        channel: body.channel,
        message_type: messageType,
        recipient_filter: body.recipientFilter ?? "all",
        segment: body.segment ?? null,
        template_code: body.channel === "alimtalk" ? body.templateCode ?? null : null,
        scheduled_at: scheduledFuture ? toIsoFromKstLocal(body.scheduledAt as string) : null,
        result_meta: { recipientCount, purpose: body.purpose ?? null, messageTypeReason },
      },
      { idempotencyKey },
    );
    logger.info("단체메시지 v2 큐잉", {
      messageId: v2.message_id,
      eventId: params.eventId,
      channel: body.channel,
      status: v2.status,
    });
    return successResponse(
      { id: v2.message_id, queued: !v2.scheduled, scheduled: v2.scheduled, recipientCount },
      201,
    );
  } catch (err: unknown) {
    if (err instanceof RetiredSegmentKeyError) {
      return errorResponse(err.message, 400);
    }
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    // 추첨 당첨자 세그먼트 fail-closed(v2 미앵커·커머스 조회 실패)는 사유를 그대로 전달한다.
    // 일반 500 으로 뭉개면 "왜 안 되는지" 운영자가 알 수 없어 조용한 무발송과 다를 바 없다.
    if (err instanceof V2LotteryWonEntriesError) {
      return errorResponse(err.message, 502);
    }
    // W3-MSG fail-closed: 수신거부/블랙리스트 판정 실패 · 상품 세그먼트 해석 실패 ·
    // 소유검증용 v2 장애는 **503**. 500 으로 뭉개면 "왜 발송이 막혔는지" 알 수 없고,
    // 더 나쁘게는 재시도 가능한 일시 장애가 영구 실패처럼 보인다.
    if (err instanceof V2MessagingComplianceError || err instanceof V2SegmentTicketsError) {
      return errorResponse(err.message, 503);
    }
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    if (err instanceof EventAccessError) {
      return errorResponse(
        err.reason === "not_found" ? ERR.NOT_FOUND : "커머스 서버에 연결할 수 없습니다",
        err.reason === "not_found" ? 404 : 503,
      );
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
