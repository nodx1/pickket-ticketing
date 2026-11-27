import { redirect } from "next/navigation";
import { EventForm, type EventFormValue } from "@/components/forms/event-form";
import type { GalleryItem } from "@/components/shared/gallery-upload";
import { FeatureToggles } from "./_components/feature-toggles";
import { CancellationPolicy } from "./_components/cancellation-policy";
import { SaleChannels } from "./_components/sale-channels";
// LandingEditor: 노출 중단(아래 렌더부 주석 참조). 컴포넌트·API 는 존치 — 도메인 기능 연결 시 복구.
import { DetailImageEditor } from "./_components/detail-image-editor";
import { UnsavedSectionsGuard } from "@/lib/hooks/unsaved-sections";
import { EventDangerZone } from "./_components/event-danger-zone";
import { EventStatusCard } from "./_components/event-status-card";
import { getServerSession } from "@/lib/auth/server-session";
import { toDateTimeLocal } from "@/lib/date";
import { getEventSummary } from "@/lib/server/events";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { listPublicationReviews, listSeats, V2CommerceError } from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";
import type { EventStatus } from "@/lib/events/status-machine";

type PageProps = {
  params: Promise<{ eventId: string }>;
};

export default async function EventSettingsPage({ params }: PageProps) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const event = await getEventSummary(eventId, session.accountId);
  if (!event) {
    redirect("/events");
  }

  // 최근 심사 이력 조회 — 반려 사유 / 승인 시각 표시용.
  //
  // ── 레벨2 컷오버 W5-SUPPORT ── go `event_reviews` 는 마이그 253 에서 DROP 됐고 정본은 v2
  //    `event_publication_reviews` 다(v2 `reviews`=관람객 후기와 **다른 개념**).
  //    🔴 여기가 누락돼 있었다: W5-SUPPORT 가 API 라우트는 v2 로 옮겼지만 이 **페이지 컴포넌트**를
  //       빠뜨려, 배포 후 설정 페이지가 `relation "event_reviews" does not exist` 로 죽었다.
  //       (같은 파일에서 bids/allocation_sessions 로 한 번 겪은 것과 **동일한 부류**다 —
  //        .tsx 페이지는 라우트 grep 에서 놓치기 쉽다.)
  //    조회 실패는 페이지를 죽이지 않는다: 심사 이력은 보조 정보이고, 여기서 throw 하면
  //    설정 화면 전체가 막힌다. 대신 빈 배열로 두되 **"이력 없음"과 구분되게** 로그를 남긴다.
  const pool = getPool();
  let reviewRows: Array<{ action: string; reason: string | null; created_at: string | null }> = [];
  try {
    const res = await listPublicationReviews(eventId, session.accountId, { limit: 5 });
    reviewRows = res.reviews.map((r) => ({
      action: r.action,
      reason: r.reason,
      created_at: r.created_at,
    }));
  } catch (err: unknown) {
    logger.warn("게시 심사 이력 조회 실패 — 이력 섹션만 비움(페이지는 유지)", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  const latestReject = reviewRows.find((r) => r.action === "reject");
  const latestApprove = reviewRows.find((r) => r.action === "approve");

  // Danger Zone 영향 범위 — 삭제 전 사용자에게 보여줄 카운트.
  //
  // ── 레벨2 컷오버 W3-OPS ── 이 쿼리는 **드롭된 테이블을 읽고 있었다**(페이지 500 크래시).
  //   · `bids` / `allocation_sessions` → mig233 에서 DROP. 추첨은 v2 로 이관됐다.
  //     남겨두면 `relation "bids" does not exist`(42P01) 로 **설정 페이지 전체가 죽는다**.
  //     (T4-추첨이 "SQL 참조 0" 으로 판정했으나 이 .tsx 페이지가 누락됐다.)
  //   · `seats` / `seat_maps` → T1 좌석 write 컷오버 이후 go 쪽 writer 가 0 이라 **항상 빈 테이블**.
  //     COUNT 는 예외 없이 0 을 돌려주므로 "지워질 좌석 0개"라는 **거짓 안심**을 준다.
  //     좌석 정본은 v2 → v2 live read 로 대체한다.
  //
  // attendees / orders 는 아직 go 테이블이 정본 투영을 들고 있어 그대로 읽는다.
  const { rows: impactRows } = await pool.query<{
    attendees: string;
    orders: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM attendees WHERE event_id = $1) AS attendees,
       (SELECT COUNT(*)::text FROM orders WHERE event_id = $1) AS orders`,
    [eventId],
  );

  // 좌석수는 v2(SoT) live read. ⚠️ v2 장애를 0 으로 위장하지 않는다 — `null`(=확인 불가)로 전달해
  // 화면이 "삭제해도 좌석 영향 없음"으로 오독되는 것을 막는다(파괴적 액션의 근거 데이터).
  let seatCount: number | null = null;
  try {
    seatCount = (await listSeats(toV2EventId(eventId), { limit: 1 })).total_seats;
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
    logger.warn("설정 페이지 좌석수 조회 실패(v2) — 영향범위에 '확인 불가' 표기", {
      eventId,
      status: err.status,
    });
  }

  const impact = {
    attendees: Number(impactRows[0]?.attendees ?? 0),
    seats: seatCount,
    orders: Number(impactRows[0]?.orders ?? 0),
  };

  const initialValue: EventFormValue = {
    organizerId: event.organizerId,
    organizers: Array.isArray(event.organizers)
      ? event.organizers.map((o: { organizerId: string; role: string; displayOrder: number }) => ({
          organizerId: o.organizerId,
          role: o.role as "host" | "coordinator" | "sponsor",
          displayOrder: o.displayOrder,
        }))
      : [{ organizerId: event.organizerId, role: "host" as const, displayOrder: 0 }],
    title: event.title,
    slug: event.slug,
    summary: event.summary ?? "",
    description: event.description ?? "",
    startsAt: toDateTimeLocal(event.startsAt),
    endsAt: toDateTimeLocal(event.endsAt),
    venueName: event.venueName ?? "",
    venueAddress: event.venueAddress ?? "",
    venueLat: event.venueLat ?? null,
    venueLng: event.venueLng ?? null,
    eventType: event.eventType as EventFormValue["eventType"],
    ageRating: event.ageRating as EventFormValue["ageRating"],
    maxAttendees: event.maxAttendees ? String(event.maxAttendees) : "",
    isOnline: event.isOnline,
    status: event.status,
    heroImageUrl: event.heroImageUrl ?? "",
    // 기존 렌디션 맵 로드(편집 반영). 미터치 저장 시 그대로 왕복, 삭제 시 {} 로 클리어 전파.
    imageVariants: event.imageVariants ?? null,
    // 갤러리는 기존값 로드(편집 반영). 빈 배열 저장은 사용자가 전부 지운 의도.
    galleryImages: (() => {
      const g = (event as { galleryImages?: unknown }).galleryImages;
      return Array.isArray(g) ? (g as GalleryItem[]) : [];
    })(),
    transportInfo: event.transportInfo ?? "",
    programNotes: event.programNotes ?? "",
    stageInfo: event.stageInfo ?? "",
    parkingInfo: event.parkingInfo ?? "",
    runtimeMinutes: (event as { runtimeMinutes?: number | null }).runtimeMinutes ?? null,
    intermissionMinutes: (event as { intermissionMinutes?: number | null }).intermissionMinutes ?? null,
    rsvpEnabled: (event as { rsvpEnabled?: boolean }).rsvpEnabled ?? false,
    // 트랙B U3 공개 랜딩 게이트 — 기존 이벤트는 false/빈문자열 폴백(하위호환).
    groupBookingEnabled: (event as { groupBookingEnabled?: boolean }).groupBookingEnabled ?? false,
    contextBanner: (event as { contextBanner?: string | null }).contextBanner ?? "",
    // F1/F4 입장방식·경품 — 기존 이벤트는 single/false 폴백(하위호환).
    admissionMode: ((event as { admissionMode?: string }).admissionMode as EventFormValue["admissionMode"]) ?? "single",
    raffleEnabled: (event as { raffleEnabled?: boolean }).raffleEnabled ?? false,
    // 좌석 판매 방식 — 값이 없던 기존 이벤트는 assigned(현행 동작 유지).
    seatType:
      ((event as { seatType?: string }).seatType as EventFormValue["seatType"]) ?? "assigned",
  };

  return (
    // 생성 화면과 같은 폭 — 입력칸이 화면 끝까지 늘어나지 않게. 이벤트 메뉴 옆에 붙인다(가운데 정렬하면 사이가 뜬다).
    <div className="w-full max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">이벤트 설정</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">이벤트 설정</h2>
      </div>
      <EventStatusCard
        eventId={eventId}
        status={event.status as EventStatus}
        rejectionReason={latestReject?.reason ?? null}
        approvedAt={latestApprove?.created_at ?? null}
      />
      {/* 저장 버튼이 구획마다 있다. 떠날 때 경고는 여기 하나가 저장 안 된 구획 이름을 모아 한 번만 묻는다. */}
      <UnsavedSectionsGuard />
      <EventForm mode="edit" eventId={eventId} initialValue={initialValue} />
      {/* 소개 글 바로 뒤에 오는 콘텐츠라 폼 다음에 둔다(화면 순서 = 랜딩 순서). */}
      <DetailImageEditor eventId={eventId} />
      <CancellationPolicy eventId={eventId} />
      <SaleChannels eventId={eventId} />
      <FeatureToggles eventId={eventId} />
      {/*
        랜딩 설정 카드(LandingEditor) 노출 중단 — 2026-07-29.

        입력 2개가 전부인데 **둘 다 소비처가 없어** 저장해도 화면에 반영되지 않았다:
          · colorScheme    → 실제 랜딩 색은 `homepage_design.backgroundColor/textColor` 가 결정
                             (`(public)/e/[eventSlug]/page.tsx` 가 그 둘만 읽는다)
          · customDomain   → 호스트를 매칭할 middleware 가 없다(proxy.ts 만 존재)

        특히 도메인은 주최자가 CNAME 을 걸어두고 안내 문구를 믿고 기다리게 되므로
        "동작하지 않는 입력을 두는 것"의 비용이 크다.

        🔴 **컴포넌트와 백엔드는 남긴다** — `PATCH /api/events/{id}/landing` 및 저장 경로 존치.
        도메인 연결을 실제로 붙일 때 이 한 줄만 되살리면 된다.
        <LandingEditor eventId={eventId} />
      */}
      <EventDangerZone eventId={eventId} status={event.status as EventStatus} impact={impact} />
    </div>
  );
}
