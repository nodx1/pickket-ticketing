/**
 * 캠페인 통계 — 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0.
 * 수신자/오픈/클릭은 v2 가 email_campaign_recipients 원장을 실측 COUNT 한다(캐시 아님).
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import {
  getCampaign,
  ledgerErrorStatus,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId, campaignId } = params as { eventId: string; campaignId: string };
  try {
    const data = await getCampaign(session.accountId, eventId, campaignId);
    if (!data) return errorResponse("캠페인을 찾을 수 없습니다", 404);
    return successResponse({
      id: data.campaign.id,
      subject: data.campaign.subject,
      status: data.campaign.status,
      stats: data.campaign.stats,
      sentAt: data.campaign.sent_at,
      totalRecipients: data.total_recipients,
      sent: data.sent,
      opened: data.opened,
      clicked: data.clicked,
    });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("캠페인 통계 조회에 실패했습니다", 500);
  }
});
