"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ticket, Eye, Users, Star } from "lucide-react";
import Link from "next/link";
import { Button } from "@pickket/ui";
import api from "@pickket/lib/api";
import {
  getMyEventStatus,
  getLotteryStats,
  type EventDetail,
  type MyEventStatus,
  type PublicLotteryStats,
  type SeatTier,
  type VenueData,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import AuthModal from "@/components/auth/AuthModal";
import { CARD } from "@/lib/styles";
import {
  getOrganizerLabels,
  normalizeSaleMode,
} from "@pickket/lib";
import { EventJsonLd } from "@/components/seo/JsonLd";
import { PromiseBadgeStrip } from "@/components/PromiseBadge";
import { useQueue } from "@/hooks/useQueue";
import { useWaitlist } from "@/hooks/useWaitlist";
import QueueWaiting from "@/components/queue/QueueWaiting";
import WaitlistStatusCard from "@/components/waitlist/WaitlistStatusCard";
import { Scale, ArrowRight } from "lucide-react";
import dynamic from "next/dynamic";

/* ── Extracted hooks ──────────────────────────────────────────────────── */
import { useEventData } from "./_hooks/useEventData";
import { useBookingState } from "./_hooks/useBookingState";
import { useEventMode } from "./_hooks/useEventMode";
import { useAllocation } from "./_hooks/useAllocation";

/* ── Layout components ───────────────────────────────────────────────── */
import { DetailPageContext } from "./detail-context";
import type { TabId } from "./detail-context";
import { ImmersiveHero } from "./_components/ImmersiveHero";
import { EventGallery } from "./_components/EventGallery";
import { TierComparisonRail } from "./_components/TierComparisonRail";
import { BentoGrid } from "./_components/BentoGrid";
import { CollapsibleCard } from "./_components/CollapsibleCard";
import { CancellationPolicyCard } from "./_components/CancellationPolicyCard";
import { EventInfoBento } from "./_components/EventInfoBento";
import { EventGapSections } from "./_components/EventGapSections";
import { CommunityPeek } from "./_components/CommunityPeek";
import { ReviewPeek } from "./_components/ReviewPeek";
import { MobileStickyBottom } from "./_components/MobileStickyBottom";
import { LineupGrid } from "./_components/LineupGrid";
import { SeatGuidePreview } from "./_components/SeatGuidePreview";
import LotteryEntryCard from "./_components/LotteryEntryCard";
import ContentWidth from "@/components/ui/ContentWidth";
import { EventContextBanner } from "./_components/EventContextBanner";
import { RsvpForm } from "./_components/RsvpForm";
import { GroupBookingDialog } from "./_components/GroupBookingDialog";
import { EventChatbot } from "./_components/EventChatbot";

/* ── Below-fold: lazy imports ────────────────────────────────────────── */
import SocialProofBar from "@/components/event-detail/SocialProofBar";
import VenuePreview from "@/components/event-detail/VenuePreview";
import SeatMapViewer from "@/components/event-detail/SeatMapViewer";

const FairnessExplainer = dynamic(
  () => import("@/components/event-detail/FairnessExplainer"),
);
const AllocationResults = dynamic(
  () => import("@/components/event-detail/AllocationResults"),
  { ssr: false },
);
const PersonalResult = dynamic(
  () => import("@/components/event-detail/PersonalResult"),
);

/* ── Helpers ───────────────────────────────────────────────────────────── */

function buildTimeSlotDates(event: EventDetail | null): string[] {
  if (!event?.time_slot_enabled) return [];
  const start = new Date(event.event_date);
  const end = new Date(event.event_date_end || event.event_date);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/* ── Skeleton ──────────────────────────────────────────────────────────── */

function SkeletonPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="relative w-full h-[85vh] bg-muted animate-pulse" />
      <div className="max-w-[1200px] mx-auto px-6 py-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-48 bg-muted rounded-2xl animate-pulse" />
        ))}
      </div>
    </div>
  );
}

/* ── Page Component ────────────────────────────────────────────────────── */

interface EventDetailClientProps {
  initialEvent?: EventDetail | null;
  initialTiers?: SeatTier[] | null;
  initialVenue?: VenueData | null;
}

export default function EventDetailPage({
  initialEvent,
  initialTiers,
  initialVenue,
}: EventDetailClientProps) {
  const t = useTranslations("event.detail");
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventId = params.id as string;
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  // 응모 완료 후 리다이렉트 시 optimistic state 설정
  // ⚠️ useQuery 가 mount 시 자동 fetch 한 응답이 replica lag 으로 stale 일 수 있어,
  // cancelQueries 로 in-flight fetch 를 취소한 뒤 setQueryData 로 즉시 확정.
  const appliedHandled = useRef(false);
  useEffect(() => {
    if (searchParams.get("applied") === "1" && !appliedHandled.current) {
      appliedHandled.current = true;
      toast.success(t("toast.lotteryApplied"));
      // 1) in-flight myStatus fetch 취소 (stale 응답이 cache 를 덮어쓰는 것 방지)
      queryClient.cancelQueries({ queryKey: ["events", eventId, "myStatus"] });
      // 2) optimistic has_lottery_entry=true 강제 반영
      queryClient.setQueryData(
        ["events", eventId, "myStatus"],
        (old: MyEventStatus | null | undefined) => ({
          has_ticket: old?.has_ticket ?? false,
          ticket_count: old?.ticket_count ?? 0,
          has_lottery_entry: true,
          lottery_status: old?.lottery_status ?? "pending",
          lottery_entry_id: old?.lottery_entry_id ?? null,
          invested_ap: old?.invested_ap ?? 0,
          lottery_tier_id: old?.lottery_tier_id ?? null,
          lottery_pool_id: old?.lottery_pool_id ?? null,
          lottery_group_size: old?.lottery_group_size ?? 1,
          lottery_order_id: old?.lottery_order_id ?? null,
        }),
      );
      router.replace(`/events/${eventId}`, { scroll: false });
    }
  }, [searchParams, eventId, router, queryClient]);

  /* ── Tab state (kept for DetailPageContext backward compatibility) ── */
  const [activeTab, setActiveTabRaw] = useState<TabId>("details");
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabRaw(tab);
  }, []);

  /* ── Data hooks ── */
  const {
    event,
    tiers,
    sessions,
    venue,
    seats,
    allocation,
    participants,
    rawSlots,
    rawAssignments,
    loading,
    loadData,
    handleSessionChange,
    isRealEvent,
  } = useEventData(eventId, initialEvent, initialTiers, initialVenue);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const booking = useBookingState();
  const {
    sidebarTierId,
    sidebarQty,
    showQueue,
    setShowQueue,
    handleSidebarTierChange,
  } = booking;

  const mode = useEventMode(event, tiers, user?.id);
  const {
    canAllocate,
    resaleTiers,
    showResale,
    soldOutTiers,
    hasSoldOut,
    showTransferSection,
    firstTier,
  } = mode;

  // #4: Display the selected tier (or fallback to first) in MobileStickyBottom
  const displayTier = useMemo(() => {
    if (sidebarTierId)
      return tiers.find((t) => t.id === sidebarTierId) ?? firstTier;
    return firstTier;
  }, [sidebarTierId, tiers, firstTier]);

  const { myResult, allocating, handleAllocate } = useAllocation(
    eventId,
    event?.status,
    isRealEvent,
    loadData,
  );

  /* ── User participation status (구매/응모 완료 여부) ── */
  // staleTime 5초: 응모 직후 optimistic state 가 replica lag(0.3~1s) 동안 stale fetch 로
  // 덮어쓰이는 race condition 방지. 5초 후엔 자연스럽게 backend 동기화.
  const { data: myStatus = null, isFetched } = useQuery<MyEventStatus | null>({
    queryKey: ["events", eventId, "myStatus"],
    queryFn: async () => {
      const res = await getMyEventStatus(eventId);
      return res.data;
    },
    enabled: !!eventId,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  // optimistic setQueryData 로 cache 가 채워졌으면 isFetched 가 false 라도 loaded 로
  // 간주 — 응모 직후 cancelQueries 한 케이스에서 CTA placeholder 가 계속 보이는 것 방지.
  const myStatusLoaded = isFetched || myStatus !== null;

  /* ── Waitlist / queue / behavior ── */
  const [waitlistTierId, setWaitlistTierId] = useState<string | null>(null);
  const [pendingJoinTier, setPendingJoinTier] = useState<string | null>(null);
  const [, setSelectedTimeSlotDate] = useState("");
  const [, setSelectedTimeSlot] = useState<{
    start: string;
    end: string;
  } | null>(null);

  const queue = useQueue(eventId);
  const waitlist = useWaitlist(eventId, waitlistTierId ?? "");
  const waitlistStatus = waitlist.status;
  const waitlistJoin = waitlist.join;
  const waitlistLeave = waitlist.leave;

  useEffect(() => {
    if (
      pendingJoinTier &&
      waitlistTierId === pendingJoinTier &&
      waitlistStatus !== "joining" &&
      waitlistStatus !== "waiting"
    ) {
      waitlistJoin();
      setPendingJoinTier(null);
    }
  }, [pendingJoinTier, waitlistTierId, waitlistJoin, waitlistStatus]);

  const bookingRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const timeSlotDates = useMemo(() => buildTimeSlotDates(event), [event]);

  useEffect(() => {
    if (timeSlotDates.length === 0) {
      setSelectedTimeSlotDate("");
      setSelectedTimeSlot(null);
      return;
    }
    setSelectedTimeSlotDate((current) =>
      timeSlotDates.includes(current) ? current : timeSlotDates[0],
    );
  }, [timeSlotDates]);

  // Quest 진행 — "이벤트 둘러보기" view_event quest 1회 트리거 (로그인 사용자만)
  useEffect(() => {
    if (!user || !event?.id) return;
    api.post(`/quests/track/view_event`).catch(() => {});
  }, [user, event?.id]);

  /* ── Lottery phase (pre_apply/applying/closed/drawing/drawn) ── */
  const isLotteryEvent = tiers.some(
    (t) => normalizeSaleMode(t.sale_mode) === "lottery",
  );
  const { data: lotteryStats } = useQuery<PublicLotteryStats>({
    queryKey: ["events", eventId, "lottery-stats"],
    queryFn: async () => {
      const res = await getLotteryStats(eventId);
      return res.data;
    },
    enabled: isLotteryEvent && !!eventId,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const lotteryPhase = lotteryStats?.phase;

  /* ── Handlers ── */
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- React Compiler가 event 전체를 deps로 추론하지만 event?.bidding_opens_at 등 특정 프로퍼티만 실제로 사용하므로 의도적 유지
  const handlePurchaseClick = useCallback(async () => {
    if (!user) {
      setShowAuthModal(true);
      return;
    }

    // lottery 이벤트 — phase 기준 엄격 가드
    if (isLotteryEvent && lotteryPhase) {
      if (lotteryPhase === "pre_apply") {
        toast.info(t("toast.lotteryNotStarted"));
        return;
      }
      if (lotteryPhase === "closed") {
        toast.info(t("toast.lotteryClosed"));
        return;
      }
      if (lotteryPhase === "drawing") {
        toast.info(t("toast.lotteryDrawing"));
        return;
      }
      if (lotteryPhase === "drawn") {
        // 결과 페이지로
        router.push(`/mypage?tab=bids`);
        return;
      }
      // applying — 통과, 이어서 시간/중복 체크
    }

    // 응모/판매 시간 체크 (server 이중 검증 + UX friendly 차단)
    const now = Date.now();
    const opensAt = event?.bidding_opens_at
      ? new Date(event.bidding_opens_at).getTime()
      : null;
    const closesAt = event?.bidding_closes_at
      ? new Date(event.bidding_closes_at).getTime()
      : null;
    if (opensAt && now < opensAt) {
      toast.info(t("toast.saleNotStarted"));
      return;
    }
    if (closesAt && now > closesAt) {
      toast.info(t("toast.saleClosed"));
      return;
    }

    // 이미 예매/응모한 상태인지 확인 (캐시 우선, 없으면 fetch)
    try {
      const cached = queryClient.getQueryData<MyEventStatus | null>([
        "events",
        eventId,
        "myStatus",
      ]);
      const status =
        cached ??
        (await queryClient.fetchQuery<MyEventStatus | null>({
          queryKey: ["events", eventId, "myStatus"],
          queryFn: async () => {
            const res = await getMyEventStatus(eventId);
            return res.data;
          },
        }));
      if (status?.has_ticket) {
        toast.info(t("toast.alreadyBooked"));
        return;
      }
      // lottery_entry 기반 프론트 차단 제거.
      // - 응모 중(applying) CTA 는 "당첨자 발표" 비활성 → 클릭 자체 불가
      // - fcfs_residual 전환 후엔 낙첨자/미결제자/대기자 모두 재구매 가능
      // - lottery 중복 응모 시도는 backend 가 거부 (lottery_service.apply)
      // 프론트 가드 중복이라 제거.
    } catch (err) {
      // myStatus 조회 실패 — 중복 예매 차단은 건너뛰고 플로우는 계속 진행 (서버에서 재검증됨)
      console.error("[EventDetailClient] getMyEventStatus failed:", err);
    }

    // 대기열 비활성화 — 바로 예매 페이지로 (TODO: 대기열 서비스 연동 후 복원)
    router.push(`/events/${eventId}/booking`);
  }, [
    user,
    router,
    eventId,
    queryClient,
    event?.bidding_opens_at,
    event?.bidding_closes_at,
    isLotteryEvent,
    lotteryPhase,
  ]);

  const handleQueueEnter = useCallback(() => {
    setShowQueue(false);
    router.push(
      `/events/${eventId}/booking${queue.token ? `?qt=${queue.token}` : ""}`,
    );
  }, [setShowQueue, router, eventId, queue.token]);

  const queueLeave = queue.leave;
  const handleQueueLeave = useCallback(() => {
    queueLeave();
    setShowQueue(false);
  }, [queueLeave, setShowQueue]);

  const handleCTAClick = useCallback(() => {
    // #7: allocated → scroll to results
    if (event?.status === "allocated") {
      resultRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    // 모든 상태에서 대기열 → 예매 페이지 흐름
    handlePurchaseClick();
  }, [event?.status, handlePurchaseClick]);

  /* ── Loading / Error states ── */
  if (loading) return <SkeletonPage />;

  if (!event) {
    return (
      <div className="max-w-6xl mx-auto pt-24 px-5 lg:pl-28 lg:pr-10 pb-24 lg:pb-8">
        <div className={`${CARD.base} p-8 text-center`}>
          <div className="mx-auto mb-6 w-20 h-20 rounded-2xl bg-red-600/10 flex items-center justify-center">
            <Ticket className="h-10 w-10 text-red-600 dark:text-red-400" />
          </div>
          <h3 className="text-lg font-bold text-foreground mb-2">
            {t("error.loadFailed")}
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto mb-6">
            {t("error.networkHint")}
          </p>
          <div className="flex gap-3 justify-center">
            <Button
              onClick={() => loadData()}
              className="rounded-full bg-primary hover:brightness-110 text-white px-6 h-10"
            >
              {t("error.retry")}
            </Button>
            <Button
              variant="outline"
              onClick={() => window.history.back()}
              className="rounded-full border-2 px-6 h-10"
            >
              {t("error.goBack")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     Stage & Curtain Layout
     ══════════════════════════════════════════════════════════════════════ */

  return (
    <DetailPageContext.Provider
      value={{
        activeTab,
        setActiveTab,
        bidCount: event.bid_count ?? 0,
        viewCount: event.view_count ?? 0,
        totalSeats: event.total_seats,
        eventStatus: event.status,
        category: event.category ?? "",
      }}
    >
      <div className="min-h-screen bg-background text-foreground">
        {/* JSON-LD */}
        <EventJsonLd
          name={event.title}
          description={event.description || ""}
          startDate={event.event_date}
          location={event.venue || ""}
          image={event.image_url}
          url={`${process.env.NEXT_PUBLIC_BASE_URL || "https://v2.pickket.kr"}/events/${event.id}`}
        />

        {/* ════ 0. 컨텍스트 배너 (U3 · go 이식) — context_banner 있을 때만 ════ */}
        <EventContextBanner banner={event.context_banner} />

        {/* ════ 1. Immersive Hero ════ */}
        <ImmersiveHero
          title={event.title}
          imageUrl={event.image_url ?? null}
          imageVariants={event.image_variants ?? null}
          category={event.category}
          venue={event.venue}
          city={event.location_city}
          date={event.event_date}
          dateEnd={event.event_date_end ?? undefined}
          minPrice={event.min_price}
          maxPrice={event.max_price ?? null}
          onCTAClick={handleCTAClick}
          status={event.status}
          bidCount={event.bid_count}
          eventId={event.id}
          isLottery={
            // phase_configs SSOT — lottery phase 진행 중/예정이면 lottery 이벤트로 간주
            // tier.sale_mode 만 보면 phase 1=lottery 인데 tier 가 fixed_fcfs (격자 좌석) 인 경우
            // false 로 떨어져 응모 후 CTA 가 안 바뀌는 버그 fix.
            tiers.some((t) => t.sale_mode === "point_lottery") ||
            lotteryPhase === "applying" ||
            lotteryPhase === "pre_apply" ||
            lotteryPhase === "closed" ||
            lotteryPhase === "drawing" ||
            lotteryPhase === "drawn" ||
            (myStatus?.has_lottery_entry ?? false)
          }
          hasLotteryEntry={myStatus?.has_lottery_entry ?? false}
          hasTicket={myStatus?.has_ticket ?? false}
          biddingClosesAt={
            // phase closes_at (go 가 설정한 phase 별 마감) 우선, 없으면 event.bidding_closes_at
            lotteryStats?.closes_at ?? event.bidding_closes_at
          }
          biddingOpensAt={lotteryStats?.opens_at ?? event.bidding_opens_at}
          lotteryStatus={myStatus?.lottery_status}
          lotteryOrderId={myStatus?.lottery_order_id}
          lotteryOrderStatus={myStatus?.lottery_order_status}
          lotteryPhase={lotteryPhase}
          isSoldOut={tiers.length > 0 && tiers.every((t) => t.remaining <= 0)}
          myStatusLoaded={myStatusLoaded || !user}
        />

        {/* ════ 2. Tier Comparison Rail (Mobile only) ════ */}
        <TierComparisonRail
          tiers={tiers}
          selectedTierId={sidebarTierId}
          onSelect={handleSidebarTierChange}
        />

        {/* ════ 2.5. 한 줄 요약 (go 랜딩 이식, Phase 1-C) ════ */}
        {event.summary?.trim() ? (
          <ContentWidth className="mt-2">
            <p className="text-base sm:text-lg font-medium text-foreground/90 leading-relaxed">
              {event.summary}
            </p>
          </ContentWidth>
        ) : null}

        {/* ════ 3. Social Proof — 히어로에 밀착 ════ */}
        <ContentWidth className="mt-2 pb-2">
          <SocialProofBar
            viewCount={event.view_count ?? 0}
            bidCount={event.bid_count ?? 0}
            totalSeats={event.total_seats ?? 0}
            live
            eventId={event.id}
          />
        </ContentWidth>

        {/* ════ 3.2. RSVP · 단체예약 (U3 · go 이식) — 게이트 필드 있을 때만 ════ */}
        {event.rsvp_enabled || event.group_booking_enabled ? (
          <ContentWidth className="pb-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {event.rsvp_enabled ? (
                <RsvpForm eventId={event.id} eventTitle={event.title} />
              ) : null}
              {event.group_booking_enabled ? (
                <div className="flex items-center">
                  <div className="w-full">
                    <GroupBookingDialog
                      eventId={event.id}
                      eventTitle={event.title}
                      products={tiers.map((tier) => ({
                        id: tier.id,
                        name: tier.name,
                      }))}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </ContentWidth>
        ) : null}

        {/* ════ 3.4. 이벤트 갤러리 ════ */}
        {event.gallery_images?.length ? (
          <ContentWidth className="pb-2">
            <EventGallery images={event.gallery_images} />
          </ContentWidth>
        ) : null}

        {/* ════ 3.5. 4대 약속 배지 스트립 ════ */}
        <ContentWidth className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <PromiseBadgeStrip />
            <Link
              href="/fairness"
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              {t("promiseBadge.link")}
            </Link>
          </div>
        </ContentWidth>

        {/* ════ 4. Compact Booking Entry — 티어 카드 + CTA ════ */}
        <ContentWidth className="py-3">
          <section ref={bookingRef}>
            {/* 티어 카드 그리드 */}
            {tiers.length > 0 ? (
              <div className="space-y-3">
                <div className="hidden lg:grid grid-cols-3 gap-3">
                  {tiers.map((tier) => {
                    const fillPct =
                      tier.capacity > 0
                        ? Math.round(
                            ((tier.capacity - tier.remaining) / tier.capacity) *
                              100,
                          )
                        : 0;
                    const isSoldOut = tier.remaining <= 0;
                    return (
                      <div
                        key={tier.id}
                        className={`relative text-left rounded-2xl border p-4 transition-all duration-200 ${
                          isSoldOut
                            ? "border-border/40 bg-muted/50 opacity-50"
                            : "border-border/50 bg-background hover:border-border hover:shadow-sm hover:bg-primary/5"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-bold text-foreground">
                            {tier.name}
                          </span>
                          {isSoldOut && (
                            <span className="text-2xs font-bold text-red-600 dark:text-red-400 bg-red-600/10 px-2 py-0.5 rounded-full">
                              {t("tier.soldOut")}
                            </span>
                          )}
                          {tier.sale_mode && !isSoldOut && (
                            <span className="text-2xs font-medium text-primary/70 bg-primary/10 px-2 py-0.5 rounded-full">
                              {normalizeSaleMode(tier.sale_mode) ===
                              "fixed_fcfs"
                                ? t("tier.saleModeFcfs")
                                : t("tier.saleModeAlloc")}
                            </span>
                          )}
                        </div>
                        <p className="text-xl font-black text-foreground tracking-tight">
                          ₩
                          {(
                            tier.face_price || tier.base_price
                          ).toLocaleString()}
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all bg-primary"
                              style={{ width: `${fillPct}%` }}
                            />
                          </div>
                          <span className="text-xs-plus text-muted-foreground/60">
                            {t("tier.remaining", { count: tier.remaining ?? 0 })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* CTA는 히어로 영역으로 이동됨 */}
              </div>
            ) : (
              <SeatGuidePreview
                event={event}
                onNotify={() => toast.info(t("toast.notifySet"))}
              />
            )}

            {/* Lottery Entry Card — 응모 상세 정보 */}
            {myStatusLoaded &&
              myStatus?.has_lottery_entry &&
              myStatus.lottery_entry_id && (
                <LotteryEntryCard
                  eventId={eventId}
                  entryId={myStatus.lottery_entry_id}
                  lotteryStatus={myStatus.lottery_status}
                  investedAp={myStatus.invested_ap}
                  groupSize={myStatus.lottery_group_size}
                  tierId={myStatus.lottery_tier_id}
                  poolId={myStatus.lottery_pool_id}
                  tiers={tiers}
                  waitlistPosition={myStatus.lottery_waitlist_position}
                />
              )}

            {/* Transfer section (waitlist + resale) */}
            {showTransferSection && (
              <div className={`mt-6 ${CARD.base} space-y-5`}>
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-foreground">
                    {t("transfer.marketTitle", { ticketNoun: getOrganizerLabels(event.category).ticketNoun ?? "" })}
                  </h3>
                  <span className="inline-flex items-center gap-1 text-2xs bg-emerald-600/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-medium">
                    <Scale className="h-2.5 w-2.5" /> {t("transfer.fairTrade")}
                  </span>
                </div>

                {hasSoldOut && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="flex items-center justify-center h-5 w-5 rounded-full bg-emerald-100 text-emerald-700 text-2xs font-bold">
                        1
                      </span>
                      <h4 className="text-sm font-semibold text-foreground">
                        {t("transfer.waitlistTitle")}
                      </h4>
                      <span className="text-2xs text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                        {t("transfer.faceTransfer")}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      {t("transfer.waitlistDesc")}
                    </p>
                    <div className="grid gap-2">
                      {soldOutTiers.map((tier) => {
                        const isJoined =
                          waitlistTierId === tier.id &&
                          (waitlist.status === "waiting" ||
                            waitlist.status === "offered");
                        const fp = tier.face_price || tier.base_price;

                        if (isJoined) {
                          return (
                            <WaitlistStatusCard
                              key={tier.id}
                              position={waitlist.position}
                              totalWaiting={waitlist.totalWaiting}
                              status={waitlist.status as "waiting" | "offered"}
                              tierName={tier.name}
                              facePrice={fp}
                              offerDeadline={waitlist.offerDeadline}
                              onLeave={() => {
                                waitlistLeave();
                                setWaitlistTierId(null);
                              }}
                              onAccept={() => {
                                toast.success(t("toast.ticketAccepted"));
                              }}
                            />
                          );
                        }

                        return (
                          <div
                            key={tier.id}
                            className="flex items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50/30 px-4 py-3"
                          >
                            <div>
                              <span className="text-sm font-semibold text-foreground">
                                {tier.name}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {t("transfer.facePrice", { price: fp ?? 0 })}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              className="h-8 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4"
                              onClick={() => {
                                if (!user) {
                                  toast.error(t("toast.loginRequired"));
                                  return;
                                }
                                setWaitlistTierId(tier.id);
                                setPendingJoinTier(tier.id);
                              }}
                              disabled={waitlistStatus === "joining"}
                            >
                              <Users className="h-3 w-3 mr-1" />
                              {t("transfer.joinWaitlist")}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {showResale && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="flex items-center justify-center h-5 w-5 rounded-full bg-primary/10 text-primary/70 text-2xs font-bold">
                        {hasSoldOut ? "2" : "1"}
                      </span>
                      <h4 className="text-sm font-semibold text-foreground">
                        {t("transfer.resaleTitle")}
                      </h4>
                      <span className="text-2xs bg-emerald-600/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-medium">
                        LIVE
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      {t("transfer.resaleDesc")}
                    </p>
                    <div className="grid gap-2">
                      {resaleTiers.map((tier) => (
                        <Link
                          key={tier.id}
                          href={`/resale/${eventId}/${tier.id}`}
                          className="flex items-center justify-between rounded-xl border border-border px-4 py-3 hover:bg-card transition-colors group"
                        >
                          <div>
                            <span className="text-sm font-semibold text-foreground">
                              {tier.name}
                            </span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {t("transfer.facePrice", { price: (tier.face_price || tier.base_price) ?? 0 })}
                            </span>
                          </div>
                          <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-2xs text-muted-foreground/60 text-center">
                  {t("transfer.legalNote")}
                </p>
              </div>
            )}

            {/* Organizer panel */}
            {canAllocate && (
              <div className="mt-6 rounded-2xl bg-amber-50 border border-amber-200/50 shadow-sm p-5 lg:p-6">
                <h2 className="font-semibold text-amber-800 mb-2">
                  {t("organizer.panelTitle")}
                </h2>
                <p className="text-sm text-amber-700 mb-4">
                  {t("organizer.panelDesc")}
                </p>
                <Button
                  onClick={handleAllocate}
                  disabled={allocating}
                  className="rounded-full bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {allocating ? t("organizer.allocating") : t("organizer.allocate")}
                </Button>
              </div>
            )}

            {/* Allocation results */}
            {allocation && <AllocationResults allocation={allocation} />}
            <div ref={resultRef}>
              {myResult && (
                <PersonalResult myResult={myResult} eventId={eventId} />
              )}
            </div>
          </section>
        </ContentWidth>

        {/* ════ 5. Info Sections ════ */}
        {/* pb-28: 모바일 하단 sticky 예매바(~72px)에 마지막 카드가 가리지 않게 여백 확보 */}
        <BentoGrid className="pb-28 lg:pb-6">
          {/* 공연 정보 */}
          <EventInfoBento
            event={event}
            tiers={tiers}
            sessions={sessions}
            participants={participants}
            rawSlots={rawSlots}
            rawAssignments={rawAssignments}
            onSessionChange={handleSessionChange}
          />

          {/* 일정·공연시간·오시는 길·설문 (go 랜딩 이식, Phase 1-C — 없으면 미표시) */}
          <EventGapSections event={event} />

          {/* 취소·환불 정책 (주최자 설정, go→v2 전파) */}
          <CancellationPolicyCard tiers={event.cancellation_fee_tiers} />

          {/* 좌석 배치도 — 원본 canvas(seat_map_data) 우선, 없으면 venue.sections 파생 뷰,
              둘 다 없으면 seat_map_url 이미지로 graceful 폴백 (Phase 1-Map). */}
          {(() => {
            const hasSeatMapData =
              !!event.seat_map_data &&
              Array.isArray(event.seat_map_data.maps) &&
              event.seat_map_data.maps.length > 0;
            const hasVenueSections = !!venue && venue.sections.length > 0;
            const seatMapImageUrl = event.seat_map_url;
            const showAny =
              hasSeatMapData || hasVenueSections || !!seatMapImageUrl;
            if (!showAny) return null;
            return (
              <CollapsibleCard
                title={t("section.seatMap")}
                icon={Eye}
                defaultOpen
                span="full"
              >
                {hasSeatMapData ? (
                  <SeatMapViewer seatMapData={event.seat_map_data!} />
                ) : hasVenueSections ? (
                  <VenuePreview
                    venue={venue!}
                    tiers={tiers}
                    seats={seats}
                    category={event.category}
                    homeTeam={event.home_team}
                    awayTeam={event.away_team}
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={seatMapImageUrl!}
                    alt={t("section.seatMap")}
                    className="w-full h-auto rounded-xl border border-border/40"
                  />
                )}
              </CollapsibleCard>
            );
          })()}

          {/* 출연진 */}
          {event.artist_name && (
            <CollapsibleCard title={t("section.lineup")} icon={Users} defaultOpen>
              <LineupGrid
                lineup={[
                  {
                    name: event.artist_name,
                    role: t("section.lineupMain"),
                    image_url: event.artist_image_url,
                  },
                  ...participants
                    .filter((p) => p.name !== event.artist_name)
                    .slice(0, 7)
                    .map((p) => ({
                      name: p.name,
                      role: p.position || undefined,
                    })),
                ]}
              />
            </CollapsibleCard>
          )}

          {/* 커뮤니티 */}
          <CollapsibleCard
            title={t("section.community")}
            icon={Users}
            span="full"
            defaultOpen
          >
            <CommunityPeek
              eventId={event.id}
              eventTitle={event.title}
              eventDate={event.event_date}
              venue={event.venue}
              eventStatus={event.status}
              category={event.category}
              viewCount={event.view_count ?? 0}
              bidCount={event.bid_count ?? 0}
              totalSeats={event.total_seats ?? 0}
            />
          </CollapsibleCard>

          {/* 리뷰 — 종료된 이벤트만 */}
          {event.status === "completed" && (
            <CollapsibleCard title={t("section.review")} icon={Star} span="full" defaultOpen>
              <ReviewPeek eventId={event.id} />
            </CollapsibleCard>
          )}

          {/* 공정배분 설명 */}
          <CollapsibleCard title={t("section.fairness")} span="full">
            <div className="space-y-4">
              <FairnessExplainer eventId={event.id} category={event.category} />
            </div>
          </CollapsibleCard>
        </BentoGrid>

        {/* ════ 6. Mobile Sticky Bottom ════ */}
        {event.status !== "cancelled" && event.status !== "completed" && (
          <MobileStickyBottom
            tierName={displayTier?.name ?? t("tier.defaultName")}
            price={
              displayTier?.face_price ??
              displayTier?.base_price ??
              event.min_price ??
              0
            }
            qty={sidebarQty}
            onCTAClick={handleCTAClick}
            status={event.status}
            myStatus={myStatus}
            myStatusLoaded={myStatusLoaded || !user}
            isLottery={
              tiers.every(
                (t) => normalizeSaleMode(t.sale_mode) === "lottery",
              ) ||
              lotteryPhase === "applying" ||
              lotteryPhase === "pre_apply" ||
              lotteryPhase === "closed" ||
              lotteryPhase === "drawing" ||
              lotteryPhase === "drawn" ||
              (myStatus?.has_lottery_entry ?? false)
            }
            lotteryPhase={lotteryPhase}
            biddingClosesAt={lotteryStats?.closes_at ?? event.bidding_closes_at}
            biddingOpensAt={lotteryStats?.opens_at ?? event.bidding_opens_at}
            competitionRatio={
              displayTier
                ? displayTier.capacity > 0
                  ? (displayTier.capacity - displayTier.remaining) /
                    displayTier.capacity
                  : 0
                : undefined
            }
            isSoldOut={tiers.length > 0 && tiers.every((t) => t.remaining <= 0)}
            salesPaused={event.sales_paused ?? false}
          />
        )}

        {/* Queue waiting overlay */}
        {showQueue && (
          <QueueWaiting
            position={queue.position}
            totalWaiting={queue.totalWaiting}
            estimatedWaitSeconds={queue.estimatedWaitSeconds}
            isActive={queue.isActive}
            purchaseDeadline={queue.purchaseDeadline}
            onLeave={handleQueueLeave}
            onEnter={handleQueueEnter}
            eventTitle={event.title}
          />
        )}

        <AuthModal
          open={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          onSuccess={() => {
            setShowAuthModal(false);
            loadData();
          }}
          returnUrl={`/events/${eventId}`}
        />

        {/* ════ 이벤트 챗봇 (U3 · go 이식) — FAQ 규칙엔진 팝업 ════ */}
        <EventChatbot
          eventTitle={event.title}
          venue={event.venue}
          eventDate={event.event_date}
        />
      </div>
    </DetailPageContext.Provider>
  );
}
