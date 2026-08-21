import { withAuth } from "@/lib/auth/withAuth";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { listEventInvitations, V2CommerceError } from "@/lib/v2/commerce-client";
import { ALIMTALK_TEMPLATES, hasAlimtalkCredentials } from "@/lib/notification/alimtalk";
import { hasSensCredentials } from "@/lib/sms/sens";
import { getRuntimeEnv } from "@/lib/env.runtime";
import { checkChannelId } from "@/lib/notification/channel-id";

type Params = { eventId: string };

/**
 * F2 초대 추적 목록 — 발송·열람·입장 대시보드 데이터.
 *
 * W5-ATTENDEE: 원장이 v2 정본으로 이관됐다(go `event_invitations` SQL 폐기).
 * account+event 경계는 v2 `_event_owner_guard` 가 집행한다(크로스테넌트 누출 차단).
 * 목록·집계를 v2 왕복 1회로 함께 받는다(옛 go 2쿼리).
 *
 * 🔴 fail-closed: v2 실패를 **빈 목록**으로 강등하지 않는다. 초대 0건은 "아무에게도 안
 *    보냈다"로 읽혀 주최자가 대량 초대를 **다시** 돌린다(실발송 중복 위험) → 503.
 */
export const GET = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "ticket_issuance");
  if (featureBlock) return featureBlock;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);

  try {
    const { invitations, summary } = await listEventInvitations(eventId, session.accountId, {
      status: statusFilter,
      limit,
    });

    return successResponse({
      // 🔴 발송 준비 상태 — 화면이 "왜 안 나가는지" 를 알 수 있게 서버 사실을 함께 내린다.
      //    옛 화면은 "잠시 후 순차 발송됩니다" 라고만 안내했는데, 실제로는 발송 크론이
      //    서버에 등록돼 있지 않아 **대기열에만 쌓이고 아무것도 나가지 않았다**
      //    (2026-07-28 실측: crontab 14줄 중 dispatch-invitations 0건).
      //    주최자가 화면만 보고 "보냈다" 고 믿는 상태를 만들지 않는다.
      messaging: {
        // 🔴 원본이 아니라 **판정 결과**를 내린다. 원본을 그대로 보여주면 주석이 섞인
        //    값도 "연결됨" 으로 읽힌다 — 2026-07-29 에 실제로 그래서 발견이 늦었다.
        ...(() => {
          const c = checkChannelId(getRuntimeEnv("SENS_ALIMTALK_CHANNEL_ID"));
          return { channelId: c.value, channelIdOk: c.ok, channelIdMessage: c.message };
        })(),
        templateCode: ALIMTALK_TEMPLATES.INVITATION_ISSUED.code,
        // 알림톡 자격(인증키+서비스+채널) 완비 여부. 미완비면 실발송 없이 상태만 전이한다.
        alimtalkReady: hasAlimtalkCredentials(),
        // 카톡 미사용 수신자를 문자로 받는 대체 경로. 발신번호 미등록이면 **그 수신자는 못 받는다.**
        smsFallbackReady: hasSensCredentials(),
      },
      invitations: invitations.map((i) => ({
        id: i.id,
        recipientName: i.recipient_name,
        phone: i.phone_display,
        ticketNumber: i.ticket_number,
        admissionDay: i.admission_day,
        status: i.status,
        failureReason: i.failure_reason,
        sentAt: i.sent_at,
        viewedAt: i.viewed_at,
        checkedInAt: i.checked_in_at,
        revokedAt: i.revoked_at,
        createdAt: i.created_at,
        // 🔴 `undefined`(구버전 v2)와 `null`(큐 행 없음)을 **뭉개지 않는다.**
        //    전자는 정보 없음이고 후자는 "영원히 안 나간다" 다 — 화면 판정이 정반대다.
        dispatchStatus: i.dispatch_status,
        // 🔴 보낸 대상이 지금 주인인가 — 양도 뒤 옛 번호로 나간 건을 화면이 알아야
        //    재발송 버튼을 되살린다(2026-08-12 prod 8건). undefined 는 모름이다.
        dispatchStale: i.dispatch_stale,
        sendEpoch: i.send_epoch,
        // 🔴 대기 경과의 기준 시각 — 초대권 생성 시각이 아니다(2026-08-04 실사고).
        dispatchUpdatedAt: i.dispatch_updated_at,
      })),
      summary,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("행사를 찾을 수 없습니다", 404);
      return errorResponse("초대 현황을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
