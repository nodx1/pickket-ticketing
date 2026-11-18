import { ticketCheckItem } from "@/lib/publish/ticket-check";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { getTicketReadiness } from "@/lib/server/publish-readiness";
import {
  fetchBizVerification,
  V2BizVerifError,
} from "@/lib/v2/business-verification-client";
import { listTiers, V2CommerceError, type EventDetail } from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { parseV2Schedules } from "@/lib/v2/event-schedules";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckItem {
  label: string;
  status: CheckStatus;
  message: string;
  link?: string;
}

/**
 * 게시 전 체크리스트 (레벨2 컷오버 W2-EVT — go `events`/`event_schedules`/`accounts` read 제거).
 *
 * 데이터 출처:
 *  - 이벤트 메타·랜딩 디자인·SEO·타임테이블 → v2 이벤트 상세(정본)
 *  - 유료 여부 → v2 seat_tiers(= go products + seat_tiers 통합 정본)
 *  - 사업자 인증 상태 → v2 business-verifications(정본)
 *  - 티켓/좌석 준비도 → `getTicketReadiness` (아직 go `products`/`seat_tiers` 를 읽는다 —
 *    해당 테이블 이관은 다른 트랙 소관이라 이 라우트에 `getPool` 이 남아 있다)
 *
 * 🔴 fail-closed: v2 장애를 "체크 실패(fail 항목)"로 보여주지 않는다. 주최자가 멀쩡한 설정을
 *    계속 고치며 헛수고하게 되기 때문 — 503 으로 끊는다.
 */
export const GET = withRole<{ eventId: string }>(
  "organizer",
  async (_request, { session, params }) => {
    const pool = getPool();

    let event: EventDetail;
    try {
      event = await requireOwnedEvent(params.eventId, session.accountId);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse(err.message, eventAccessStatus(err));
      }
      throw err;
    }

    let ticketReadiness: Awaited<ReturnType<typeof getTicketReadiness>>;
    let isPaid: boolean;
    try {
      const [readiness, tiers] = await Promise.all([
        getTicketReadiness(pool, params.eventId, session.accountId),
        listTiers(event.event_id),
      ]);
      ticketReadiness = readiness;
      isPaid = tiers.tiers.some((t) => Number(t.base_price) > 0);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse(err.message, eventAccessStatus(err));
      }
      if (err instanceof V2CommerceError) {
        return errorResponse(
          "커머스 서버에 연결할 수 없어 게시 점검을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
          503,
        );
      }
      throw err;
    }

    // 유료 이벤트만 사업자 인증을 조회한다(무료는 게이트 자체가 없음).
    let verificationStatus: string | null = null;
    if (isPaid) {
      try {
        verificationStatus = (await fetchBizVerification(session.accountId)).verificationStatus;
      } catch (err: unknown) {
        if (err instanceof V2BizVerifError) {
          return errorResponse(
            "사업자 인증 상태를 확인하지 못해 게시 점검을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
            503,
          );
        }
        throw err;
      }
    }

    const content = (event.content ?? {}) as Record<string, unknown>;
    const eventId = event.event_id;
    const summaryText = typeof content.summary === "string" ? content.summary : null;
    const scheduleCount = parseV2Schedules(content.event_schedules).length;
    const homepageDesign = (event.homepage_design ?? {}) as Record<string, unknown>;
    const seoMetadata = (content.seo_metadata ?? null) as Record<string, unknown> | null;
    const startsAt = event.event_date;
    const endsAt = event.event_date_end ?? event.event_date;

    const hasHomepageCopy =
      typeof homepageDesign.heroHeadline === "string" &&
      homepageDesign.heroHeadline.trim().length > 0;
    const hasCoverImage =
      Boolean(event.image_url) ||
      (typeof homepageDesign.coverImageUrl === "string" &&
        homepageDesign.coverImageUrl.trim().length > 0);
    const hasSeo = seoMetadata !== null && Object.keys(seoMetadata).length > 0;

    const checks: CheckItem[] = [
      // 유료 이벤트만 — 사업자 인증 승인 전에는 유료 발행 불가(게이트). 무료면 항목 없음.
      ...(isPaid
        ? ([
            {
              label: "사업자 인증",
              status: verificationStatus === "approved" ? "pass" : "fail",
              message:
                verificationStatus === "approved"
                  ? "사업자 인증이 완료되어 유료 판매를 발행할 수 있습니다."
                  : "유료 판매는 사업자 인증 승인 후 발행할 수 있습니다. 계정 설정 > 사업자 인증에서 신청하세요.",
              link: "/account",
            },
          ] as CheckItem[])
        : []),
      {
        label: "이벤트 제목",
        status: event.title.trim().length > 0 ? "pass" : "fail",
        message:
          event.title.trim().length > 0
            ? "이벤트 제목이 설정되었습니다."
            : "이벤트 제목을 입력하세요.",
        link: `/events/${eventId}/settings`,
      },
      {
        label: "이벤트 설명",
        status: event.description ?? summaryText ? "pass" : "warn",
        message:
          event.description ?? summaryText
            ? "이벤트 소개가 작성되었습니다."
            : "설명을 추가하면 검색 노출과 전환율에 도움이 됩니다.",
        link: `/events/${eventId}/settings`,
      },
      {
        label: "대표 이미지",
        status: hasCoverImage ? "pass" : "warn",
        message: hasCoverImage
          ? "공유용 대표 이미지가 준비되었습니다."
          : "커버 이미지를 추가하면 SNS 공유 성과가 좋아집니다.",
        link: `/events/${eventId}/homepage-designer`,
      },
      {
        label: "일시 설정",
        status: startsAt && endsAt ? "pass" : "fail",
        message:
          startsAt && endsAt
            ? "시작과 종료 일정이 설정되었습니다."
            : "시작/종료 일시를 모두 설정하세요.",
        link: `/events/${eventId}/settings`,
      },
      {
        label: "장소 정보",
        status: event.venue && event.venue_address ? "pass" : "warn",
        message:
          event.venue && event.venue_address
            ? "장소와 주소 정보가 준비되었습니다."
            : "장소와 주소를 입력하면 참석자 안내에 유리합니다.",
        link: `/events/${eventId}/settings`,
      },
      {
        label: "티켓 (좌석 등급)",
        // 지정석은 등급 + 발행된 배치도, 자유 입장은 등급만으로 판매 가능(lib/publish/ticket-check).
        // 부가상품(products)은 옵션이라 여기선 체크하지 않음.
        ...ticketCheckItem({ ...ticketReadiness, seatType: event.seat_type ?? "assigned" }),
        link: `/events/${eventId}/tickets`,
      },
      {
        label: "이벤트 일정",
        status: scheduleCount > 0 ? "pass" : "warn",
        message:
          scheduleCount > 0
            ? `${scheduleCount}개 일정이 등록되어 있습니다.`
            : "다회차 행사라면 일정을 등록해 참석자 혼선을 줄이세요.",
        link: `/events/${eventId}/schedules`,
      },
      {
        label: "랜딩 카피",
        status: hasHomepageCopy ? "pass" : "warn",
        message: hasHomepageCopy
          ? "메인 랜딩 문구가 준비되었습니다."
          : "홈페이지 디자이너에서 헤드라인을 설정해 보세요.",
        link: `/events/${eventId}/homepage-designer`,
      },
      {
        label: "SEO 메타데이터",
        status: hasSeo ? "pass" : "warn",
        message: hasSeo
          ? "SEO 메타데이터가 설정되었습니다."
          : "이벤트 설정에서 검색 최적화 정보를 입력해 보세요.",
        link: `/events/${eventId}/settings`,
      },
    ];

    return successResponse(checks);
  },
);
