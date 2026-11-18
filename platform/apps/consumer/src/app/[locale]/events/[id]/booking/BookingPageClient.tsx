"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { currentLocale } from "@/lib/locale-path";
import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  getQueueStatus,
  getMyEventStatus,
  prepareOrderPayment,
  cancelOrder,
  releaseSeats,
  applyLottery,
  getLotteryStatus,
  getLotteryStats,
  type PublicLotteryStats,
  type EventDetail,
  type MyEventStatus,
  type SeatTier,
} from "@pickket/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEventData } from "../_hooks/useEventData";
import { useBookingFlow, clearPersistedBooking } from "@/hooks/useBookingFlow";
import { isTossLive, type PayMethod } from "@/lib/toss";
import { useTossWidget } from "@/hooks/useTossWidget";
import { startPayment } from "@/lib/pay";
import {
  type NicePayMethod,
  DEFAULT_NICE_METHOD,
  getNiceMethods,
  isNiceCardOnly,
  isNicePayMethodSelectable,
} from "@/lib/nicepay-methods";
import BookingHeader from "./_components/BookingHeader";
import SeatMapPanel from "./_components/SeatMapPanel";
import GeneralAdmissionPanel from "./_components/GeneralAdmissionPanel";
import TicketPanel from "./_components/TicketPanel";
import LotteryApplyPanel from "./_components/LotteryApplyPanel";
import LotteryApplyModal from "./_components/LotteryApplyModal";
import LotteryPaymentPanel from "./_components/LotteryPaymentPanel";
import MobileBookingSheet from "./_components/MobileBookingSheet";
import AuthModal from "@/components/auth/AuthModal";
import GuestCheckoutModal from "@/components/booking/GuestCheckoutModal";
import { useAuthStore } from "@pickket/store";
import { normalizeSaleMode } from "@pickket/lib";
import type { OrderInfo } from "@/hooks/usePayment";

import PaymentConfirmModal from "@/components/payment/PaymentConfirmModal";
import PaymentCompleteInline from "@/components/payment/PaymentCompleteInline";

interface BookingPageClientProps {
  initialEvent?: EventDetail | null;
}

const QUEUE_SESSION_KEY_PREFIX = "pickket_queue_";

export default function BookingPageClient({
  initialEvent,
}: BookingPageClientProps) {
  const t = useTranslations("booking.pageClient");
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventId = params.id as string;

  /* ── Queue token ── */
  const qtParam = searchParams.get("qt");
  const sessionKey = `${QUEUE_SESSION_KEY_PREFIX}${eventId}`;
  const [queueTokenVerified, setQueueTokenVerified] = useState(false);
  const justAppliedLotteryRef = useRef(false);
  const tokenCheckDone = useRef(false);
  // 결제 더블서밋 방지 — setPaying(상태) 가드는 React 동시모드에서 같은 틱 내 2회 클릭을
  // 막지 못하므로 동기 ref 락을 둔다 (usePayment.executePayment 와 동일 패턴).
  const payLockRef = useRef(false);

  useEffect(() => {
    if (tokenCheckDone.current) return;
    tokenCheckDone.current = true;

    let token = qtParam;
    if (token) {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({ token, timestamp: Date.now() }),
        );
      } catch {
        // sessionStorage 쓰기 실패는 브라우저 제약(프라이빗 모드 등) — 조용히 무시
      }
      router.replace(`/events/${eventId}/booking`, { scroll: false });
    } else {
      try {
        const saved = sessionStorage.getItem(sessionKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.token && Date.now() - parsed.timestamp < 30 * 60 * 1000) {
            token = parsed.token;
          }
        }
      } catch {
        // sessionStorage 읽기/파싱 실패 — 토큰 없는 상태로 진행 (브라우저 제약은 예상됨)
      }
    }

    if (!token) {
      setQueueTokenVerified(true);
      return;
    }

    getQueueStatus(eventId)
      .then((res) => {
        if (res.data.is_active) {
          setQueueTokenVerified(true);
        } else {
          toast.error(t("queueExpired"));
          try {
            sessionStorage.removeItem(sessionKey);
          } catch {
            // sessionStorage 삭제 실패 — 브라우저 제약, 무시
          }
          router.replace(`/events/${eventId}`);
        }
      })
      .catch((err) => {
        // 대기열 상태 조회 실패 — 사용자에게 알리고 이벤트 페이지로 되돌림
        console.error("[BookingPageClient] getQueueStatus failed:", err);
        toast.error(t("queueExpired"));
        try {
          sessionStorage.removeItem(sessionKey);
        } catch {
          // sessionStorage 삭제 실패 — 브라우저 제약, 무시
        }
        router.replace(`/events/${eventId}`);
      });
  }, [qtParam, eventId, sessionKey, router]);

  /* ── 이미 예매/응모 완료된 경우 리다이렉트 (캐시 공유) ── */
  const queryClient = useQueryClient();
  const { data: myStatus } = useQuery<MyEventStatus | null>({
    queryKey: ["events", eventId, "myStatus"],
    queryFn: async () => {
      const res = await getMyEventStatus(eventId);
      return res.data;
    },
    enabled: !!eventId,
  });

  const isLotteryPay = searchParams.get("lottery_pay") === "1";

  /* ── Event data ── */
  const { event, tiers, sessions, venue, seats, loading, tiersReady } =
    useEventData(eventId, initialEvent);

  useEffect(() => {
    if (!myStatus || justAppliedLotteryRef.current || isLotteryPay) return;
    // has_ticket (PENDING 제외, 결제 확정된 ticket만 true) 기반으로만 차단.
    // lottery_entry 기반 차단은 제거 — fcfs_residual 전환 후 재구매 허용해야 하고,
    // lottery 중복 응모는 backend apply 에서 거부됨.
    if (myStatus.has_ticket) {
      toast.info(t("alreadyBooked"));
      router.replace(`/events/${eventId}`);
    }
  }, [myStatus, eventId, router, isLotteryPay]);

  /* ── Booking flow hook ── */
  const booking = useBookingFlow(eventId);

  /* ── Step-based flow: tier → seat → payment ── */
  // Auto-advance to tier step when session is selected
  // booking 객체 자체를 deps에 추가하면 매 렌더마다 재실행 무한루프 위험
  useEffect(() => {
    if (booking.step === "session" && booking.selectedSessionEventId) {
      booking.goToStep("tier");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.step, booking.selectedSessionEventId, booking.goToStep]);

  const seatSelectionActive = booking.step === "seat";

  /* ── 결제 모달 상태 (직접 관리 — usePayment 제거) ── */
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [_pendingOrderAmount, setPendingOrderAmount] = useState<number | null>(
    null,
  );
  const [orderInfo, setOrderInfo] = useState<OrderInfo | null>(null);
  // 결제수단 선택은 토스 위젯이 담당 — payMethod 는 완료 표시용(레거시).
  const [payMethod] = useState<PayMethod>("card");
  // 나이스페이(구형): 결제수단 선택값(prepare 의 pay_method 로 전달). 토스면 미노출.
  // 카드전용 게이팅(C2): 이벤트 allowed_pay_methods 를 훅포인트에 주입.
  //   NULL/미제공 → 전체 노출(현행 무변). ["CARD"] → 카드 고정(선택 UI 숨김).
  const niceProviderActive = isNicePayMethodSelectable();
  const niceMethods = getNiceMethods(event?.allowed_pay_methods);
  const niceCardOnly = isNiceCardOnly(event?.allowed_pay_methods);
  const showNiceMethods = niceProviderActive && !niceCardOnly;
  const [niceMethod, setNiceMethod] = useState<NicePayMethod>(DEFAULT_NICE_METHOD);
  // 카드전용이면 CARD 강제(선택 무시), 아니면 사용자 선택값.
  const effectiveNiceMethod: NicePayMethod = niceCardOnly ? "CARD" : niceMethod;
  const [agreed, setAgreed] = useState(false);
  const [paying, setPaying] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const { user } = useAuthStore();

  /* ── 결제 완료 상태 ── */
  const [showComplete, setShowComplete] = useState(false);
  // 토스 리다이렉트 모델: 결제 완료는 success 페이지→주문상세에서 처리되어
  // 이 인페이지 완료 모달은 표시되지 않는다(상태는 하위 호환 위해 유지).
  const [paymentResult] = useState<{
    paymentId: string;
    amount: number;
    payMethod: PayMethod;
    paidAt: string;
  } | null>(null);

  /* ── Derive assigned seating ── */
  const selectedTier =
    tiers.find((t) => t.id === booking.selectedTierId) ?? null;
  const isAssigned = selectedTier?.seating_type === "assigned" && !!venue;
  // 게스트(비회원) 체크아웃 허용: 이벤트 opt-in + tier 가 fixed_fcfs/무료(회원전용 배제).
  const guestTierIsFree =
    (selectedTier?.face_price ?? selectedTier?.base_price ?? 0) <= 0 ||
    event?.is_free === true;
  const guestEligible =
    event?.guest_checkout_enabled === true &&
    !!selectedTier &&
    (normalizeSaleMode(selectedTier.sale_mode) === "fixed_fcfs" ||
      guestTierIsFree);
  const selectedTierStatusLabel = selectedTier
    ? t("tierSelected", { name: selectedTier.name ?? "", price: (selectedTier.face_price || selectedTier.base_price).toLocaleString("ko-KR") })
    : t("tierNotSelected");
  const paymentTotalLabel = orderInfo
    ? t("amountWon", { amount: orderInfo.totalAmount.toLocaleString("ko-KR") })
    : t("paymentAmountUnset");
  const orderSummaryAriaLabel = orderInfo
    ? t("orderSummaryFull", { eventTitle: orderInfo.eventTitle ?? "", tierName: orderInfo.tierName ?? "", quantity: orderInfo.quantity ?? 0, total: paymentTotalLabel })
    : t("orderSummary");

  /* ── Lottery 이벤트 감지 ──
   * 어느 tier 하나라도 sale_mode === "point_lottery" 이면 추첨 모드로 간주.
   * 이 경우 좌석 선택/결제 UI 숨기고 구역별 응모 UI 노출.
   */
  const isLotteryEvent = tiers.some((t) => t.sale_mode === "point_lottery");
  /** 응모 마감 시각(phase_configs 정본) — 응모 패널에 표시. 이벤트 상세와 같은 공개 통계를 쓴다. */
  const { data: lotteryStats } = useQuery<PublicLotteryStats>({
    queryKey: ["events", eventId, "lottery-stats"],
    queryFn: async () => (await getLotteryStats(eventId)).data,
    enabled: isLotteryEvent && !!eventId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  /** 자유 입장(좌석 배치도 없음) — 배치도 대신 행사 요약 패널을 보여 준다. */
  const isGeneralAdmission = event?.seat_type === "unassigned";
  const generalAdmissionDate = event?.event_date
    ? new Date(event.event_date).toLocaleString(params.locale === "ko" || !params.locale ? "ko-KR" : "en-US", {
        year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
      })
    : null;

  /* ── Lottery 응모 모달 상태 ── */
  const [lotteryApplyTarget, setLotteryApplyTarget] = useState<{
    tier: SeatTier;
    sectionName: string;
  } | null>(null);
  const [myLotteryEntry, setMyLotteryEntry] = useState<{
    tierId: string;
    tierName: string;
    sectionName: string;
    groupSize: number;
    investedAp: number;
  } | null>(null);

  /* ── 구역별 응모자 수 폴링 (5초 주기, lottery 이벤트에서만) ── */
  const [entryCountsByTier, setEntryCountsByTier] = useState<
    Record<string, number>
  >({});

  useEffect(() => {
    if (!isLotteryEvent || tiers.length === 0) return;
    let cancelled = false;

    const fetchAll = async () => {
      const results = await Promise.all(
        tiers.map(async (t) => {
          try {
            const res = await getLotteryStatus(eventId, t.id);
            const data = res.data as { total_applicants?: number };
            return [t.id, data.total_applicants ?? 0] as const;
          } catch {
            return [t.id, 0] as const;
          }
        }),
      );
      if (!cancelled) {
        setEntryCountsByTier(Object.fromEntries(results));
      }
    };

    fetchAll();
    const iv = setInterval(fetchAll, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [isLotteryEvent, tiers, eventId]);

  const handleOpenLotteryApply = useCallback(
    (args: { tier: SeatTier; sectionName: string }) => {
      setLotteryApplyTarget(args);
    },
    [],
  );

  const handleSubmitLottery = useCallback(
    async ({
      groupSize,
      investedAp,
    }: {
      groupSize: number;
      investedAp: number;
    }) => {
      if (!lotteryApplyTarget) return;
      const { tier, sectionName } = lotteryApplyTarget;
      try {
        await applyLottery(eventId, tier.id, {
          group_size: groupSize,
          client_seed: crypto.randomUUID(),
          invested_ap: investedAp > 0 ? investedAp : undefined,
        });
        setMyLotteryEntry({
          tierId: tier.id,
          tierName: tier.name,
          sectionName,
          groupSize,
          investedAp,
        });
        // 응모 직후 해당 tier 카운트 즉시 +1 (폴링 기다리지 않고 UI 반영)
        setEntryCountsByTier((prev) => ({
          ...prev,
          [tier.id]: (prev[tier.id] ?? 0) + 1,
        }));
        setLotteryApplyTarget(null);
        // myStatus 캐시 optimistic 업데이트 — 상세 페이지에서 CTA 가 즉시 비활성으로 전환됨.
        // invalidateQueries 만 쓰면 refetch 가 끝나기 전 짧은 순간 stale cache 보여서
        // "응모하기" 버튼 다시 눌릴 수 있음.
        queryClient.setQueryData(
          ["events", eventId, "myStatus"],
          (old: MyEventStatus | null | undefined) => ({
            has_ticket: old?.has_ticket ?? false,
            ticket_count: old?.ticket_count ?? 0,
            has_lottery_entry: true,
            lottery_status: "pending",
            lottery_entry_id: old?.lottery_entry_id ?? null,
            invested_ap: investedAp,
            lottery_tier_id: tier.id,
            lottery_pool_id: old?.lottery_pool_id ?? null,
            lottery_group_size: groupSize,
            lottery_order_id: old?.lottery_order_id ?? null,
          }),
        );
        // refetch 즉시 호출은 DB replication lag (write→read) 으로 stale 응답이 와서
        // 응모 완료 UI 가 다시 "응모하기" 로 되돌아가는 race condition 유발.
        // 200 응답 받았으면 backend 가 commit 된 거라 optimistic state 신뢰. 페이지
        // 재진입 시 자연스럽게 동기화됨.
        // 응모 완료 → 이벤트 상세로 이동
        router.push(`/events/${eventId}?applied=1`);
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ||
          (err as { message?: string })?.message ||
          t("lotteryFailed");
        toast.error(msg);
      }
    },
    [eventId, lotteryApplyTarget, queryClient, router],
  );

  useEffect(() => {
    booking.setIsAssigned(isAssigned);
    // booking 객체 자체를 deps에 추가하면 무한루프 위험
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAssigned, booking.setIsAssigned]);

  /* ── Order created → 결제 확인 모달 띄우기 ── */
  const handleOrderCreated = useCallback(
    (orderId: string, totalPrice: number) => {
      const tierName = selectedTier?.name ?? "";
      const unitPrice = selectedTier
        ? (selectedTier.face_price || selectedTier.base_price)
        : 0;
      const qty = isAssigned ? booking.selectedSeats.length : booking.quantity;

      setPendingOrderId(orderId);
      setPendingOrderAmount(totalPrice);
      setOrderInfo({
        eventTitle: event?.title ?? "",
        tierName,
        unitPrice,
        quantity: qty,
        fees: { platformFee: 0, organizerShare: 0 },
        totalAmount: totalPrice,
      });
      setAgreed(false);
      setPaying(false);
      setShowConfirmModal(true);
    },
    [
      selectedTier,
      isAssigned,
      booking.selectedSeats.length,
      booking.quantity,
      event?.title,
    ],
  );

  // 결제 확인 모달에서 토스 결제위젯 렌더(모달이 컨테이너 divs 제공).
  const {
    widgetRef: tossWidgetRef,
    ready: widgetReady,
    error: widgetError,
    reload: reloadWidget,
  } = useTossWidget(orderInfo?.totalAmount ?? 0, showConfirmModal);
  // 라이브 결제인데 위젯이 아직 준비 안 됐으면 결제 진행 차단(무한 로딩 상태에서의 클릭 방지).
  const payDisabled = isTossLive() && !widgetReady;

  /* ── 결제 실행 ── */
  const handleExecutePayment = useCallback(async () => {
    if (!orderInfo || !pendingOrderId || !agreed) return;
    if (payLockRef.current) return; // 동기 락: 인플라이트 중 재진입 차단
    payLockRef.current = true;
    setPaying(true);
    try {
      // provider(토스/나이스) 분기는 공통 startPayment 로 위임(3중복제 공통화).
      // 성공 경로는 리다이렉트로 종료 — 정상 흐름은 아래 도달 전에 페이지를 떠난다.
      const locale = currentLocale();
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const successUrl = `${origin}/${locale}/payment/success?order=${encodeURIComponent(pendingOrderId)}`;
      const failUrl = `${origin}/${locale}/payment/fail?order=${encodeURIComponent(pendingOrderId)}`;
      clearPersistedBooking(eventId);
      await startPayment({
        orderId: pendingOrderId,
        orderName: `${orderInfo.eventTitle} - ${orderInfo.tierName}`,
        amount: orderInfo.totalAmount,
        successUrl,
        failUrl,
        tossWidget: tossWidgetRef.current,
        // 나이스 provider 활성 시 pay_method 전달(카드전용도 CARD 명시). 토스는 서버가 무시.
        payMethod: niceProviderActive ? effectiveNiceMethod : undefined,
        // 나이스 인증 오류(취소·창닫힘)는 SDK 콜백으로 도착 — 토스트+락 해제.
        onNiceError: (message) => {
          toast.error(message);
          setPaying(false);
          payLockRef.current = false;
        },
        // 나이스 goPay 팝업 닫힘/취소 → paying 고착 탈출. 주문은 pending 유지(재시도 허용).
        onNiceCancel: (message) => {
          toast.error(message ?? t("paymentCanceled"));
          setPaying(false);
          payLockRef.current = false;
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("paymentFailed");
      toast.error(msg);
      setPaying(false);
      payLockRef.current = false;
    }
  }, [
    orderInfo,
    pendingOrderId,
    agreed,
    eventId,
    t,
    tossWidgetRef,
    niceProviderActive,
    effectiveNiceMethod,
  ]);

  /* ── 수동 탈출구(belt-and-suspenders) ──
   * 나이스 goPay 팝업이 닫혔는데 SDK 콜백(nicepayClose/fnError)이 발화하지 않아도
   * 사용자가 processing(paying) 상태를 직접 탈출할 수 있게 한다. 주문은 pending 유지(재시도 허용). */
  const handleCancelProcessing = useCallback(() => {
    toast.error(t("paymentCanceled"));
    setPaying(false);
    payLockRef.current = false;
  }, [t]);

  /* ── 당첨자 결제 (lottery_pay 모드) ── */
  const handleLotteryPay = useCallback(
    async (lotteryOrderId: string) => {
      if (!event || !myStatus) return;
      const tier = tiers.find((t) => t.id === myStatus.lottery_tier_id);
      const price = tier ? tier.face_price || tier.base_price : 0;
      // Client-side fallback amount (display only).
      let total = price * myStatus.lottery_group_size;

      // Prefer the server-authoritative amount. The backend also re-verifies the
      // amount on /orders/{id}/pay (confirm), so a tampered client value can never
      // result in an under-charge; this call just keeps the UI total accurate.
      try {
        const prepared = await prepareOrderPayment(lotteryOrderId);
        if (prepared.data?.amount) total = prepared.data.amount;
      } catch {
        // Network/prepare failure → fall back to client total; confirm still re-verifies.
      }

      setPendingOrderId(lotteryOrderId);
      setPendingOrderAmount(total);
      setOrderInfo({
        eventTitle: event.title,
        tierName: tier?.name ?? "—",
        quantity: myStatus.lottery_group_size,
        unitPrice: price,
        totalAmount: total,
        fees: { platformFee: 0, organizerShare: 0 },
      });
      setShowConfirmModal(true);
    },
    [event, myStatus, tiers],
  );

  /* ── 모달 닫기 (미결제 주문 취소 + 좌석 홀드 해제) ──
   * cancelOrder 는 서버 측에서 order cancel + seat release 까지 실행하지만,
   * 네트워크/타이밍 이슈로 실패해도 silent 였음. 실패 시 releaseSeats 로 직접 해제.
   */
  const handleCloseConfirmModal = useCallback(() => {
    if (paying) return;
    if (pendingOrderId) {
      cancelOrder(pendingOrderId).catch((err: unknown) => {
        console.error("cancelOrder failed, falling back to releaseSeats:", err);
        releaseSeats(eventId).catch(() => {
          // 둘 다 실패해도 UX 차단하지 않음. hold TTL(10분) 만료로 자연 해제됨.
        });
      });
    } else {
      // 주문 없이 hold 만 남은 예외 케이스 대비
      releaseSeats(eventId).catch(() => {});
    }
    setShowConfirmModal(false);
    setPendingOrderId(null);
    setPendingOrderAmount(null);
    setOrderInfo(null);
  }, [paying, pendingOrderId, eventId]);

  /* ── ESC로 모달 닫기 ── */
  useEffect(() => {
    if (!showConfirmModal || paying) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCloseConfirmModal();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [showConfirmModal, paying, handleCloseConfirmModal]);

  /* ── Auth required — 게스트 허용이면 GuestCheckoutModal, 아니면 로그인 게이트 ── */
  const handleAuthRequired = useCallback(() => {
    if (guestEligible) {
      setShowGuestModal(true);
    } else {
      setShowAuthModal(true);
    }
  }, [guestEligible]);

  /* ── Lottery applied ── */
  const handleLotteryApplied = useCallback(() => {
    justAppliedLotteryRef.current = true;
  }, []);

  /* ── Auto-select session ── */
  useEffect(() => {
    if (sessions.length === 1 && !booking.selectedSessionEventId) {
      booking.selectSession(sessions[0].event_id);
    }
    // booking 객체 자체를 deps에 추가하면 무한루프 위험
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, booking.selectedSessionEventId, booking.selectSession]);

  /* ── 이벤트 상태 리다이렉트 ── */
  useEffect(() => {
    if (!event) return;
    if (event.status === "cancelled" || event.status === "completed") {
      router.replace(`/events/${eventId}`);
    }
  }, [event, eventId, router]);

  /* ── Warn before leaving ── */
  useEffect(() => {
    const hasProgress =
      booking.selectedTierId || booking.selectedSeats.length > 0;
    if (!hasProgress || justAppliedLotteryRef.current) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [booking.selectedTierId, booking.selectedSeats.length]);

  /* ── Release hold on unmount ── */
  const releaseCurrentHold = booking.releaseCurrentHold;
  useEffect(() => {
    return () => {
      releaseCurrentHold();
    };
  }, [releaseCurrentHold]);

  /* ── Hold expired ── */
  const handleHoldExpired = useCallback(() => {
    releaseCurrentHold();
    toast.error(t("holdExpired"));
  }, [releaseCurrentHold]);

  /* ── TicketPanel callbacks ── */
  // booking 객체 자체를 deps에 추가하면 무한루프 위험 (커스텀 훅 객체는 매 렌더마다 새 참조)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSelectTier = useCallback((tierId: string) => { booking.selectTier(tierId); }, [booking.selectTier]);
  // 배치도에서 클릭 시 tier 선택만 (seat step으로 안 넘어감)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleMapSelectTier = useCallback((tierId: string) => { booking.selectTier(tierId); }, [booking.selectTier]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleGoToSeatSelection = useCallback(() => booking.goToStep("seat"), [booking.goToStep]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleExitSeatSelection = useCallback(() => { booking.goToStep("tier"); booking.setSelectedSeats([]); }, [booking.goToStep, booking.setSelectedSeats]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSetQuantity = useCallback((qty: number) => booking.setQuantity(qty, selectedTier?.max_group_size ?? 4), [booking.setQuantity, selectedTier?.max_group_size]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleToggleSeat = useCallback((seat: Parameters<typeof booking.toggleSeat>[0]) => booking.toggleSeat(seat, selectedTier?.max_group_size ?? 4), [booking.toggleSeat, selectedTier?.max_group_size]);

  /* ── Loading ── */
  if (loading || !tiersReady || !queueTokenVerified) {
    return (
      <div
        className="sr-only"
        aria-busy="true"
        aria-live="polite"
        aria-label={t("loadingLabel")}
      />
    );
  }
  if (!event) {
    router.replace(`/events/${eventId}`);
    return null;
  }

  /* ── 당첨자 결제 모드 ── */
  if (isLotteryPay && myStatus?.lottery_status === "won") {
    return (
      <div
        className="h-full flex flex-col bg-background text-foreground overflow-hidden"
        aria-busy={paying}
        aria-label={t("lotteryPayScreenLabel")}
      >
        <BookingHeader
          title={event.title}
          venue={event.venue}
          date={event.event_date}
          imageUrl={event.image_url}
        />
        <div
          className="flex-1 flex items-center justify-center"
          aria-label={t("lotteryTicketPayLabel")}
        >
          <LotteryPaymentPanel
            eventId={eventId}
            eventTitle={event.title}
            myStatus={myStatus}
            tiers={tiers}
            onPay={handleLotteryPay}
            paying={paying || showConfirmModal}
          />
        </div>
        {showConfirmModal && orderInfo && (
          <div
            aria-label={orderSummaryAriaLabel}
            aria-describedby="lottery-payment-total"
          >
            <span
              id="lottery-payment-total"
              className="sr-only"
              aria-live="polite"
            >
              {t("payLabel", { total: paymentTotalLabel })}
            </span>
            <PaymentConfirmModal
              open={showConfirmModal}
              onClose={handleCloseConfirmModal}
              orderInfo={orderInfo}
              agreed={agreed}
              onAgreedChange={setAgreed}
              payMethod={payMethod}
              widgetReady={widgetReady}
              widgetError={widgetError}
              onReloadWidget={reloadWidget}
              payDisabled={payDisabled}
              paying={paying}
              showNiceMethods={showNiceMethods}
              niceMethods={niceMethods}
              niceMethod={niceMethod}
              onNiceMethodChange={setNiceMethod}
              niceCardOnly={niceProviderActive && niceCardOnly}
              onConfirm={handleExecutePayment}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-background text-foreground overflow-hidden"
      aria-busy={paying}
      aria-label={t("bookingScreenLabel")}
      aria-describedby="booking-tier-status"
    >
      <p
        id="booking-tier-status"
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {selectedTierStatusLabel}
      </p>
      <BookingHeader
        title={event.title}
        venue={event.venue}
        date={event.event_date}
        imageUrl={event.image_url}
        holdExpiresAt={booking.holdExpiresAt}
        onHoldExpired={handleHoldExpired}
      />

      {/* ── 데스크톱: 좌우 분할 ── */}
      <div
        className="hidden lg:flex flex-1 min-h-0 flex-row overflow-hidden"
        aria-label={t("desktopBookingLabel")}
      >
        {isGeneralAdmission ? (
          <GeneralAdmissionPanel title={event.title} venue={event.venue} dateText={generalAdmissionDate} imageUrl={event.image_url} />
        ) : (
          <SeatMapPanel
            eventId={eventId}
            venue={venue}
            tiers={tiers}
            preloadedSeats={seats}
            selectedTier={selectedTier}
            selectedSeats={booking.selectedSeats}
            quantity={booking.quantity}
            onSelectTier={handleMapSelectTier}
            onToggleSeat={handleToggleSeat}
            onSetSelectedSeats={booking.setSelectedSeats}
            category={event.category}
            homeTeam={event.home_team}
            awayTeam={event.away_team}
            eventImageUrl={event.image_url}
            eventTitle={event.title}
            seatSelectionActive={isLotteryEvent ? false : seatSelectionActive}
            onExitSeatSelection={handleExitSeatSelection}
            event={event}
            lotteryMode={isLotteryEvent}
            onSectionClickForLottery={({ sectionName, tierId }) => {
              const tier = tiers.find((t) => t.id === tierId);
              if (tier) setLotteryApplyTarget({ tier, sectionName });
            }}
          />
        )}
        {isLotteryEvent ? (
          <LotteryApplyPanel
            eventId={eventId}
            locale={(params.locale as string) ?? "ko"}
            eventTitle={event.title}
            tiers={tiers}
            sections={venue?.sections ?? []}
            entryCountsByTier={entryCountsByTier}
            myEntry={myLotteryEntry}
            closesAt={lotteryStats?.closes_at ?? null}
            refreshKey={myLotteryEntry ? 1 : 0}
            onOpenApplyModal={handleOpenLotteryApply}
          />
        ) : (
          <TicketPanel
            tiers={tiers}
            sessions={sessions}
            selectedTierId={booking.selectedTierId}
            selectedSessionEventId={booking.selectedSessionEventId}
            selectedSeats={booking.selectedSeats}
            quantity={booking.quantity}
            isAssignedSeating={isAssigned}
            onSelectTier={handleSelectTier}
            onSetQuantity={handleSetQuantity}
            onToggleSeat={handleToggleSeat}
            onSetSelectedSeats={booking.setSelectedSeats}
            eventTitle={event.title}
            eventId={eventId}
            category={event.category}
            onOrderCreated={handleOrderCreated}
            onAuthRequired={handleAuthRequired}
            onLotteryApplied={handleLotteryApplied}
            seatSelectionActive={seatSelectionActive}
            onGoToSeatSelection={handleGoToSeatSelection}
            onExitSeatSelection={handleExitSeatSelection}
          />
        )}
      </div>

      {/* ── 모바일: 구역 배치도 + 하단 바 ── */}
      <div
        className="flex-1 min-h-0 flex flex-col overflow-hidden lg:hidden pb-[140px]"
        aria-label={t("mobileSeatMapLabel")}
        aria-describedby="booking-tier-status"
      >
        {isGeneralAdmission ? (
          <GeneralAdmissionPanel title={event.title} venue={event.venue} dateText={generalAdmissionDate} imageUrl={event.image_url} />
        ) : (
          <SeatMapPanel
            eventId={eventId}
            venue={venue}
            tiers={tiers}
            preloadedSeats={seats}
            selectedTier={selectedTier}
            selectedSeats={booking.selectedSeats}
            quantity={booking.quantity}
            onSelectTier={handleMapSelectTier}
            onToggleSeat={handleToggleSeat}
            onSetSelectedSeats={booking.setSelectedSeats}
            category={event.category}
            homeTeam={event.home_team}
            awayTeam={event.away_team}
            eventImageUrl={event.image_url}
            eventTitle={event.title}
            seatSelectionActive={isLotteryEvent ? false : seatSelectionActive}
            onExitSeatSelection={handleExitSeatSelection}
            event={event}
            lotteryMode={isLotteryEvent}
            onSectionClickForLottery={({ sectionName, tierId }) => {
              const tier = tiers.find((t) => t.id === tierId);
              if (tier) setLotteryApplyTarget({ tier, sectionName });
            }}
          />
        )}
      </div>
      <div
        className="lg:hidden"
        aria-label={t("mobileBookingPanelLabel")}
        aria-busy={paying}
      >
        {isLotteryEvent ? (
          <LotteryApplyPanel
            eventId={eventId}
            locale={(params.locale as string) ?? "ko"}
            eventTitle={event.title}
            tiers={tiers}
            sections={venue?.sections ?? []}
            entryCountsByTier={entryCountsByTier}
            myEntry={myLotteryEntry}
            closesAt={lotteryStats?.closes_at ?? null}
            refreshKey={myLotteryEntry ? 1 : 0}
            onOpenApplyModal={handleOpenLotteryApply}
          />
        ) : (
          <MobileBookingSheet
            tiers={tiers}
            sessions={sessions}
            selectedTierId={booking.selectedTierId}
            selectedSessionEventId={booking.selectedSessionEventId}
            selectedSeats={booking.selectedSeats}
            quantity={booking.quantity}
            isAssignedSeating={isAssigned}
            onSelectTier={handleSelectTier}
            onSetQuantity={handleSetQuantity}
            onToggleSeat={handleToggleSeat}
            onSetSelectedSeats={booking.setSelectedSeats}
            eventTitle={event.title}
            eventId={eventId}
            category={event.category}
            onOrderCreated={handleOrderCreated}
            onAuthRequired={handleAuthRequired}
            onLotteryApplied={handleLotteryApplied}
            seatSelectionActive={seatSelectionActive}
            onGoToSeatSelection={handleGoToSeatSelection}
            onExitSeatSelection={handleExitSeatSelection}
          />
        )}
      </div>

      {/* 추첨 응모 모달 */}
      <LotteryApplyModal
        open={lotteryApplyTarget !== null}
        tier={lotteryApplyTarget?.tier ?? null}
        sectionName={lotteryApplyTarget?.sectionName ?? ""}
        currentEntryCount={
          lotteryApplyTarget
            ? (entryCountsByTier[lotteryApplyTarget.tier.id] ?? 0)
            : 0
        }
        capacity={
          lotteryApplyTarget
            ? (venue?.sections.find(
                (s) => s.name === lotteryApplyTarget.sectionName,
              )?.capacity ?? lotteryApplyTarget.tier.capacity)
            : 0
        }
        onClose={() => setLotteryApplyTarget(null)}
        onSubmit={handleSubmitLottery}
      />

      <AuthModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={() => setShowAuthModal(false)}
        returnUrl={`/events/${eventId}/booking`}
      />

      {/* ── 게스트(비회원) 체크아웃 모달 ── */}
      {event && selectedTier && guestEligible && !user && (
        <GuestCheckoutModal
          open={showGuestModal}
          onClose={() => setShowGuestModal(false)}
          event={event}
          tier={selectedTier}
          quantity={booking.quantity}
          selectedSeats={booking.selectedSeats}
          holdId={booking.holdId}
          onSwitchToLogin={() => setShowAuthModal(true)}
        />
      )}

      {/* ── 결제 확인 모달 ── */}
      {showConfirmModal && orderInfo && (
        <div
          aria-label={orderSummaryAriaLabel}
          aria-describedby="booking-payment-total"
        >
          <span
            id="booking-payment-total"
            className="sr-only"
            aria-live="polite"
          >
            {t("payLabel", { total: paymentTotalLabel })}
          </span>
          <PaymentConfirmModal
            open={showConfirmModal}
            orderInfo={orderInfo}
            payMethod={payMethod}
            agreed={agreed}
            paying={paying}
            widgetReady={widgetReady}
            widgetError={widgetError}
            onReloadWidget={reloadWidget}
            payDisabled={payDisabled}
            showNiceMethods={showNiceMethods}
            niceMethods={niceMethods}
            niceMethod={niceMethod}
            onNiceMethodChange={setNiceMethod}
            niceCardOnly={niceProviderActive && niceCardOnly}
            provider={niceProviderActive ? "nicepay" : "toss"}
            onCancelProcessing={handleCancelProcessing}
            onAgreedChange={setAgreed}
            onConfirm={handleExecutePayment}
            onClose={handleCloseConfirmModal}
          />
        </div>
      )}

      {/* ── 결제 완료 모달 ── */}
      {showComplete && orderInfo && paymentResult && (
        <PaymentCompleteInline
          open={showComplete}
          orderInfo={orderInfo}
          paymentResult={paymentResult}
          onViewTickets={() => {
            setShowComplete(false);
            clearPersistedBooking(eventId);
            router.replace("/mypage?tab=tickets");
          }}
          onBrowseEvents={() => {
            setShowComplete(false);
            clearPersistedBooking(eventId);
            router.replace("/events");
          }}
        />
      )}
    </div>
  );
}
