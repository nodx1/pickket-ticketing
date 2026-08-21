/**
 * 이메일 캠페인 발송 — v2 광고성 EventMessage 로 큐잉(발송은 v2 Celery 소유).
 *
 * 🔴 무조건 v2 위임(레벨2 컷오버 W5-MSG). email_campaigns / email_campaign_recipients 원장이
 *   v2 로 이관돼 go DB 에는 읽을 캠페인도, 스냅샷할 수신자 테이블도 없다. flag 조건부로 두면
 *   flag OFF 에서 없는 테이블을 조회한다.
 *
 * 🔴 이중발송 차단 2겹
 *   ① 멱등키 `campaign-send:{campaignId}` — 안정 키라 재시도가 EventMessage 를 두 건 만들지 않는다.
 *   ② v2 `campaigns/mark-sent` 가 **draft 인 행만** sent 로 바꾼다(원장 레벨 CAS). 동시 2회
 *      호출 시 한 번만 성공하고 두 번째는 409 → 큐잉이 이미 끝난 캠페인으로 안내한다.
 *   순서: 큐잉(외부호출) → mark-sent. 큐잉 후 crash 하면 mark-sent 가 안 되지만, 재시도 시
 *   ①이 같은 EventMessage 를 재생하므로 수신자에게 2회 나가지 않는다.
 */
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { countSegment, type Segment } from "@/lib/notification/recipients";
import { logger } from "@/lib/logger";
import { createOrganizerMessage } from "@/lib/v2/commerce-client";
import { V2MessagingComplianceError } from "@/lib/v2/messaging-compliance-client";
import {
  getCampaign,
  ledgerErrorStatus,
  markCampaignSent,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";
import { V2SegmentTicketsError } from "@/lib/v2/segment-tickets";

// 대량 마케팅 발송 — organizer 이상만(뷰어/스태프 대량발송 차단).
export const POST = withRole<{ eventId: string; campaignId: string }>(
  "organizer",
  async (request, { session, params }) => {
    const { eventId, campaignId } = params;

    // dryRun 지원: 쿼리파라미터 또는 body JSON.
    let dryRun = false;
    const url = new URL(request.url);
    if (url.searchParams.get("dryRun") === "true") {
      dryRun = true;
    } else {
      try {
        const bodyText = await request.text();
        if (bodyText) {
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          if (parsed.dryRun === true) dryRun = true;
        }
      } catch {
        // body 없거나 파싱 실패 시 무시
      }
    }

    try {
      const data = await getCampaign(session.accountId, eventId, campaignId);
      if (!data) return errorResponse("캠페인을 찾을 수 없습니다", 404);
      const campaign = data.campaign;
      if (!dryRun && campaign.status !== "draft") {
        return errorResponse("발송 가능한 상태가 아닙니다", 400);
      }

      // H-07: 캠페인의 저장된 segment 로 수신자 해석(메시지와 동일 리졸버 공유).
      // 빈 segment = 전체 활성 참석자. 수신거부·블랙리스트·환불주문 제외는 리졸버가 적용.
      const seg: Segment = (campaign.segment as Segment | null) ?? {};
      const recipientCount = await countSegment(session.accountId, eventId, "email", seg);
      if (dryRun) return successResponse({ recipientCount });

      const scheduledFuture =
        campaign.scheduled_at != null && new Date(campaign.scheduled_at).getTime() > Date.now();
      const v2 = await createOrganizerMessage(
        {
          go_account_id: session.accountId,
          event_id: eventId,
          title: campaign.subject,
          body: campaign.body_html,
          channel: "email",
          message_type: "advertising",
          segment: (campaign.segment as Record<string, unknown> | null) ?? null,
          scheduled_at: scheduledFuture ? new Date(campaign.scheduled_at as string).toISOString() : null,
          result_meta: { source: "campaign", campaignId },
        },
        { idempotencyKey: `campaign-send:${campaignId}` },
      );

      // 원장 레벨 CAS — draft 인 행만 sent 로. 이미 sent 면 409(중복 send 차단).
      try {
        await markCampaignSent(session.accountId, eventId, campaignId);
      } catch (err: unknown) {
        if (err instanceof V2MessagingLedgerError && err.status === 409) {
          logger.warn("캠페인 중복 발송 시도 — 이미 발송 확정됨", { campaignId });
          return errorResponse("이미 발송된 캠페인입니다", 409);
        }
        throw err;
      }

      logger.info("이메일 캠페인 v2 큐잉", { campaignId, messageId: v2.message_id, status: v2.status });
      return successResponse({
        queued: v2.scheduled ? 0 : recipientCount,
        scheduled: v2.scheduled,
        recipientCount,
      });
    } catch (err: unknown) {
      // 🔴 fail-closed: 수신자 해석/억제 판정/원장 조회 실패는 503(재시도 가능)으로 알린다.
      if (err instanceof V2MessagingComplianceError || err instanceof V2SegmentTicketsError) {
        return errorResponse(err.message, 503);
      }
      if (err instanceof V2MessagingLedgerError) {
        return errorResponse(err.message, ledgerErrorStatus(err));
      }
      return errorResponse(err instanceof Error ? err.message : "캠페인 발송에 실패했습니다", 500);
    }
  },
);
