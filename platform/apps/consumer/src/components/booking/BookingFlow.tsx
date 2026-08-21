"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Check,
  Loader2,
  Clock,
  AlertTriangle,
  Info,
  MapPin,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import {
  type EventDetail,
  type SeatTier,
  type SeatData,
  type SessionData,
  type VenueData,
  getEventSeats,
} from "@pickket/lib/api";
import { useBookingFlow, type BookingStep } from "@/hooks/useBookingFlow";
import { useAuthStore } from "@pickket/store";
import { cn } from "@pickket/lib";
import { getOrganizerLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";

import SessionPicker from "./SessionPicker";
import SeatPicker from "./SeatPicker";
import BookingSummary from "./BookingSummary";
import ConcertHallMap from "./ConcertHallMap";
import TierSelector from "@/components/event-detail/TierSelector";
import ActionPanel from "@/components/event-detail/ActionPanel";
import AuthModal from "@/components/auth/AuthModal";
import GuestCheckoutModal from "./GuestCheckoutModal";
import { isDemoTier } from "@/lib/fallback-data";
import { normalizeSaleMode } from "@pickket/lib";

export interface BookingStateInfo {
  selectedSeats: number;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  tierId: string | null;
}

interface BookingFlowProps {
  event: EventDetail;
  sessions: SessionData[];
  tiers: SeatTier[];
  venue: VenueData | null;
  participants?: Array<{ position: string; name: string; session_id?: string }>;
  onSessionChange?: (sessionEventId: string) => void;
  initialTierId?: string | null;
  initialQuantity?: number;
  onStepChange?: (step: BookingStep) => void;
  onTierSelect?: (tierId: string) => void;
  onBookingStateChange?: (state: BookingStateInfo) => void;
}

/* Step definitions — session label is domain-adaptive */
const STEP_NUMBERS: Record<BookingStep, number> = {
  session: 1,
  tier: 2,
  seat: 3,
  payment: 4,
};

function getStepMeta(
  step: BookingStep,
  t: (key: string) => string,
  category?: string,
) {
  const labels = getOrganizerLabels(category);
  const map: Record<BookingStep, string> = {
    session: labels.sessionPickerLabel,
    tier: t("select_tier"),
    seat: t("select_seat"),
    payment: t("payment"),
  };
  return { label: map[step], number: STEP_NUMBERS[step] };
}

/* Skip seat selection only for unassigned seating (auto-assigned after allocation) */

/* Fluid easing for step transitions */
const STEP_TRANSITION = {
  duration: 0.3,
  ease: [0.3, 0, 0, 1] as const,
};

/* ── Floating Hold Timer ─────────────────────────────────── */
function FloatingHoldTimer({
  holdExpiresAt,
  onExpire,
  ticketNoun = "좌석",
}: {
  holdExpiresAt: string;
  onExpire: () => void;
  ticketNoun?: string;
}) {
  const [remaining, setRemaining] = useState(() => {
    const diff = new Date(holdExpiresAt).getTime() - Date.now();
    if (diff <= 0) return { min: 0, sec: 0, expired: true, total: 0 };
    const total = Math.floor(diff / 1000);
    return {
      min: Math.floor(total / 60),
      sec: total % 60,
      expired: false,
      total,
    };
  });

  useEffect(() => {
    const tick = () => {
      const diff = new Date(holdExpiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining({ min: 0, sec: 0, expired: true, total: 0 });
        return;
      }
      const total = Math.floor(diff / 1000);
      setRemaining({
        min: Math.floor(total / 60),
        sec: total % 60,
        expired: false,
        total,
      });
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [holdExpiresAt]);

  useEffect(() => {
    if (remaining.expired) onExpire();
  }, [remaining.expired, onExpire]);

  if (remaining.expired) return null;

  const pad = (n: number) => n.toString().padStart(2, "0");
  const isUrgent = remaining.total < 180;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={cn(
        "sticky top-0 z-20 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm",
        isUrgent
          ? "bg-red-600/10 text-red-600 dark:text-red-400 animate-pulse"
          : "bg-amber-600/10 text-amber-600 dark:text-amber-400",
      )}
    >
      {isUrgent ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : (
        <Clock className="h-4 w-4 shrink-0" />
      )}
      {ticketNoun} 확보 시간: {pad(remaining.min)}:{pad(remaining.sec)} 남음
    </motion.div>
  );
}

export default function BookingFlow({
  event,
  sessions,
  tiers,
  venue,
  participants,
  onSessionChange,
  initialTierId,
  initialQuantity,
  onStepChange,
  onTierSelect,
  onBookingStateChange,
}: BookingFlowProps) {
  const booking = useBookingFlow(event.id);
  const { user } = useAuthStore();
  const t = useTranslations("booking");
  const [isHolding, setIsHolding] = useState(false);
  const [allSeats, setAllSeats] = useState<SeatData[]>([]);

  // 좌석 좌표 데이터 로드
  useEffect(() => {
    if (!venue) return;
    getEventSeats(event.id)
      .then((res) => {
        const data = res.data ?? res;
        if (Array.isArray(data)) setAllSeats(data);
      })
      .catch(() => {});
  }, [event.id, venue]);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const bookingRef = useRef(booking);
  useEffect(() => {
    bookingRef.current = booking;
  });
  const {
    setIsAssigned,
    selectedSessionEventId,
    selectSession,
    step,
    goToStep,
  } = booking;

  const hasSessions = sessions.length > 1;
  const selectedTier =
    tiers.find((t) => t.id === booking.selectedTierId) ?? null;
  const skipSeatStep = selectedTier
    ? selectedTier.seating_type !== "assigned"
    : false;
  const isAssigned = selectedTier?.seating_type === "assigned" && !!venue;

  // 게스트(비회원) 체크아웃 허용 여부:
  //   이벤트 opt-in(guest_checkout_enabled) + 선택 tier 가 게스트 허용(fixed_fcfs 또는 무료).
  //   lottery/fanclub 은 회원전용(백엔드 화이트리스트도 배제) → AuthModal 유지.
  const tierSaleMode = selectedTier ? normalizeSaleMode(selectedTier.sale_mode) : null;
  const tierIsFree =
    (selectedTier?.face_price ?? selectedTier?.base_price ?? 0) <= 0 ||
    event.is_free === true;
  const guestEligible =
    event.guest_checkout_enabled === true &&
    (tierSaleMode === "fixed_fcfs" || tierIsFree);

  // Sync isAssigned to booking hook
  useEffect(() => {
    setIsAssigned(isAssigned);
  }, [isAssigned, setIsAssigned]);

  // Release hold on unmount — skip if navigating to login
  useEffect(() => {
    return () => {
      if (
        bookingRef.current.holdId &&
        !sessionStorage.getItem("pickket_login_redirect")
      ) {
        bookingRef.current.releaseCurrentHold();
      }
    };
  }, []);

  // Warn user before leaving if booking is in progress
  useEffect(() => {
    const hasProgress =
      booking.selectedTierId || booking.selectedSeats.length > 0;
    if (!hasProgress) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers show their own message, the returnValue is needed for compatibility
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [booking.selectedTierId, booking.selectedSeats.length]);

  // Restored session toast + auto-advance after social login return — mount-only
  const restoredHandledRef = useRef(false);
  const handleNextRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (restoredHandledRef.current) return;
    restoredHandledRef.current = true;
    if (booking.isRestoredSession) {
      const wasLoginRedirect = sessionStorage.getItem("pickket_login_redirect");
      sessionStorage.removeItem("pickket_login_redirect");
      if (wasLoginRedirect) {
        toast.info("이전 예매를 이어서 진행합니다.");
        // Auto-advance to next step after social login return
        if (user && booking.step !== "payment") {
          setTimeout(() => handleNextRef.current(), 500);
        }
      }
      if (
        booking.holdExpiresAt &&
        new Date(booking.holdExpiresAt).getTime() <= Date.now()
      ) {
        toast.warning("좌석 확보 시간이 만료되었습니다. 다시 선택해주세요.");
      }
    }
  }, [booking.isRestoredSession, booking.step, booking.holdExpiresAt, user]);

  // Compute active steps
  const activeSteps = useMemo<BookingStep[]>(() => {
    const steps: BookingStep[] = [];
    if (hasSessions) steps.push("session");
    steps.push("tier");
    if (!skipSeatStep) steps.push("seat");
    steps.push("payment");
    return steps;
  }, [hasSessions, skipSeatStep]);

  // Auto-select session if single
  useEffect(() => {
    if (sessions.length === 1 && !selectedSessionEventId) {
      selectSession(sessions[0].event_id);
    }
  }, [sessions, selectedSessionEventId, selectSession]);

  // If current step is not in active steps, adjust
  useEffect(() => {
    if (!activeSteps.includes(step)) {
      goToStep(activeSteps[0]);
    }
  }, [activeSteps, step, goToStep]);

  // Sidebar → BookingFlow: auto-select tier from sidebar (no auto-advance)
  const prevInitialTierRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (initialTierId && initialTierId !== prevInitialTierRef.current) {
      prevInitialTierRef.current = initialTierId;
      const matchedTier = tiers.find((t) => t.id === initialTierId);
      if (!matchedTier) return;
      bookingRef.current.selectTier(initialTierId);
      if (initialQuantity && initialQuantity > 1) {
        bookingRef.current.setQuantity(
          initialQuantity,
          matchedTier.max_group_size ?? 4,
        );
      }
      // Navigate to tier step so user can confirm and click CTA
      if (bookingRef.current.step !== "tier") {
        setTimeout(() => bookingRef.current.goToStep("tier"), 300);
      }
    }
  }, [initialTierId, initialQuantity, tiers]);

  // Notify parent of booking state changes (price, seats)
  useEffect(() => {
    if (!onBookingStateChange) return;
    const unitPrice = selectedTier
      ? (selectedTier.face_price ?? selectedTier.base_price)
      : 0;
    const count = isAssigned ? booking.selectedSeats.length : booking.quantity;
    onBookingStateChange({
      selectedSeats: booking.selectedSeats.length,
      quantity: booking.quantity,
      unitPrice,
      totalPrice: unitPrice * count,
      tierId: booking.selectedTierId,
    });
  }, [
    booking.selectedSeats,
    booking.quantity,
    booking.selectedTierId,
    selectedTier,
    isAssigned,
    onBookingStateChange,
  ]);

  // Auto-scroll to step nav on mobile when step changes
  const stepNavRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window === "undefined" || window.innerWidth >= 1024) return;
    const timer = setTimeout(() => {
      stepNavRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [booking.step]);

  // Notify parent of step changes
  useEffect(() => {
    onStepChange?.(booking.step);
  }, [booking.step, onStepChange]);

  const currentStepIdx = activeSteps.indexOf(step);
  const selectedSession =
    sessions.find((s) => s.event_id === selectedSessionEventId) ?? null;

  const handleNext = async () => {
    const nextIdx = currentStepIdx + 1;
    if (nextIdx >= activeSteps.length) return;

    // Auth gate: require login before payment step (skip for demo mode).
    // 게스트 허용 이벤트/티어면 로그인 대신 GuestCheckoutModal 로 분기.
    if (
      activeSteps[nextIdx] === "payment" &&
      !user &&
      !isDemoTier(booking.selectedTierId ?? "")
    ) {
      if (guestEligible) {
        setShowGuestModal(true);
      } else {
        setShowAuthModal(true);
      }
      return;
    }

    if (
      activeSteps[nextIdx] === "payment" &&
      isAssigned &&
      booking.selectedSeats.length > 0
    ) {
      // Skip hold API for demo tiers — backend won't have these seats
      if (!isDemoTier(booking.selectedTierId ?? "")) {
        setIsHolding(true);
        const success = await booking.holdSelectedSeats();
        setIsHolding(false);
        if (!success) return;
      }
    }
    booking.goToStep(activeSteps[nextIdx]);
  };

  // Keep ref synced so mount-only effect can call handleNext without forward-ref cycle.
  // Write in an effect (not during render) to satisfy react-hooks/refs under React 19.
  useEffect(() => {
    handleNextRef.current = () => {
      void handleNext();
    };
  });

  const handleAuthSuccess = useCallback(() => {
    setShowAuthModal(false);
    sessionStorage.removeItem("pickket_login_redirect");
    // Re-trigger next step after successful login
    setTimeout(() => {
      const nextIdx = activeSteps.indexOf(step) + 1;
      if (nextIdx < activeSteps.length) {
        if (
          activeSteps[nextIdx] === "payment" &&
          isAssigned &&
          bookingRef.current.selectedSeats.length > 0
        ) {
          if (isDemoTier(bookingRef.current.selectedTierId ?? "")) {
            bookingRef.current.goToStep(activeSteps[nextIdx]);
          } else {
            setIsHolding(true);
            bookingRef.current.holdSelectedSeats().then((success) => {
              setIsHolding(false);
              if (success) bookingRef.current.goToStep(activeSteps[nextIdx]);
            });
          }
        } else {
          bookingRef.current.goToStep(activeSteps[nextIdx]);
        }
      }
    }, 100);
  }, [activeSteps, step, isAssigned]);

  const handlePrev = async () => {
    const prevIdx = currentStepIdx - 1;
    if (prevIdx >= 0) {
      if (booking.step === "payment" && booking.holdId) {
        await booking.releaseCurrentHold();
      }
      booking.goToStep(activeSteps[prevIdx]);
    }
  };

  const handleHoldExpire = useCallback(() => {
    booking.releaseCurrentHold();
    const seatIdx = activeSteps.indexOf("seat");
    if (seatIdx >= 0) booking.goToStep("seat");
  }, [booking, activeSteps]);

  const getStepLabel = (step: BookingStep) => {
    if (step === "seat") return isAssigned ? t("select_seat") : t("quantity");
    return getStepMeta(step, t, event.category).label;
  };

  return (
    <div className="space-y-5 rounded-2xl">
      {/* Floating hold timer — always visible during payment */}
      <AnimatePresence>
        {booking.holdExpiresAt && booking.step === "payment" && (
          <FloatingHoldTimer
            holdExpiresAt={booking.holdExpiresAt}
            onExpire={handleHoldExpire}
            ticketNoun={getOrganizerLabels(event.category).ticketNoun}
          />
        )}
      </AnimatePresence>

      {/* Step indicator with connecting lines */}
      <nav
        ref={stepNavRef}
        className="flex items-center gap-0 overflow-x-auto pb-1 scroll-mt-20"
        aria-label="예매 단계"
      >
        {activeSteps.map((step, idx) => {
          const isCurrent = booking.step === step;
          const isCompleted = idx < currentStepIdx;
          const isClickable = isCompleted;

          return (
            <React.Fragment key={step}>
              {/* Connecting line */}
              {idx > 0 && (
                <div
                  className={cn(
                    "h-0.5 flex-1 min-w-[16px] max-w-[40px] transition-colors duration-300",
                    idx <= currentStepIdx ? "bg-primary" : "bg-border",
                  )}
                />
              )}

              {/* Step pill */}
              <button
                type="button"
                onClick={async () => {
                  if (!isClickable || isHolding) return;
                  if (
                    booking.step === "payment" &&
                    booking.holdId &&
                    step !== "payment"
                  ) {
                    await booking.releaseCurrentHold();
                  }
                  booking.goToStep(step);
                }}
                disabled={!isClickable || isHolding}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2.5 rounded-full text-sm font-medium transition-all whitespace-nowrap will-change-transform",
                  isCurrent &&
                    "bg-primary text-white shadow-[0_0_16px_rgba(10,10,10,0.4)]",
                  isCompleted &&
                    "bg-emerald-600/15 text-emerald-600 dark:text-emerald-400 cursor-pointer hover:bg-emerald-600/25",
                  !isCurrent &&
                    !isCompleted &&
                    "bg-card text-muted-foreground/60 border border-border",
                )}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <span className="text-xs">{STEP_NUMBERS[step]}</span>
                )}
                {getStepLabel(step)}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {/* Step content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={booking.step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={STEP_TRANSITION}
        >
          {/* Session step */}
          {booking.step === "session" && (
            <SessionPicker
              sessions={sessions}
              selectedEventId={booking.selectedSessionEventId}
              sessionLabel={
                getOrganizerLabels(event.category).sessionPickerLabel
              }
              category={event.category}
              participants={participants}
              onSelect={(id) => {
                booking.selectSession(id);
                onSessionChange?.(id);
                setTimeout(() => booking.goToStep("tier"), 300);
              }}
            />
          )}

          {/* Tier step */}
          {booking.step === "tier" && (
            <div className="space-y-5">
              {/* 좌석 배치도 + 등급 카드 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* 좌석 배치도 (왼쪽) */}
                {venue && tiers.some((t) => t.seating_type === "assigned") && (
                  <div className="rounded-2xl border border-border overflow-hidden min-h-[300px]">
                    <ConcertHallMap
                      tiers={tiers}
                      selectedTierId={booking.selectedTierId}
                      onSelectTier={(id) => {
                        booking.selectTier(id);
                        prevInitialTierRef.current = id;
                        onTierSelect?.(id);
                      }}
                      venue={venue}
                      seats={allSeats}
                      selectedSeatIds={
                        new Set(booking.selectedSeats.map((s) => s.id))
                      }
                      onSelectSeat={(seat) => booking.toggleSeat(seat)}
                    />
                  </div>
                )}

                {/* 등급 선택 카드 (오른쪽) */}
                <div>
                  <TierSelector
                    tiers={tiers}
                    selectedTierId={booking.selectedTierId}
                    category={event.category}
                    onSelect={(id) => {
                      booking.selectTier(id);
                      prevInitialTierRef.current = id;
                      onTierSelect?.(id);
                    }}
                  />
                </div>
              </div>

              {/* 좌석 선택하러 가기 CTA */}
              <AnimatePresence>
                {booking.selectedTierId &&
                  (() => {
                    const nextTier = tiers.find(
                      (t) => t.id === booking.selectedTierId,
                    );
                    if (!nextTier) return null;
                    const tierIsAssigned = nextTier.seating_type === "assigned";
                    return (
                      <motion.div
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 16 }}
                        transition={{ duration: 0.25, ease: [0.3, 0, 0, 1] }}
                        className="sticky bottom-0 z-10 bg-card/95 backdrop-blur-xl border border-border rounded-2xl shadow-[0_4px_20px_rgba(0,0,0,0.3)] p-4"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="size-3 rounded-full bg-primary shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-foreground truncate">
                                {nextTier.name} 선택됨
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {nextTier.remaining}석 남음
                              </p>
                            </div>
                          </div>
                          <Button
                            onClick={() => {
                              const skipSeat = !tierIsAssigned;
                              const nextStep = skipSeat ? "payment" : "seat";
                              if (nextStep === "payment" && !user) {
                                // 게스트 허용이면 GuestCheckoutModal, 아니면 로그인 게이트.
                                const nextIsFree =
                                  (nextTier.face_price ??
                                    nextTier.base_price ??
                                    0) <= 0 || event.is_free === true;
                                const nextGuestEligible =
                                  event.guest_checkout_enabled === true &&
                                  (normalizeSaleMode(nextTier.sale_mode) ===
                                    "fixed_fcfs" ||
                                    nextIsFree);
                                if (nextGuestEligible) {
                                  setShowGuestModal(true);
                                } else {
                                  setShowAuthModal(true);
                                }
                                return;
                              }
                              booking.goToStep(nextStep);
                            }}
                            className="rounded-full px-6 bg-primary hover:brightness-110 text-white shadow-lg shadow-[rgba(10,10,10,0.3)] shrink-0"
                          >
                            <MapPin className="h-4 w-4 mr-1.5" />
                            {tierIsAssigned ? t("go_to_seat") : t("payment")}
                          </Button>
                        </div>
                      </motion.div>
                    );
                  })()}
              </AnimatePresence>
            </div>
          )}

          {/* Seat step */}
          {booking.step === "seat" && selectedTier && (
            <SeatPicker
              eventId={event.id}
              venue={venue}
              tier={selectedTier}
              selectedSeats={booking.selectedSeats}
              quantity={booking.quantity}
              onToggleSeat={(seat) =>
                booking.toggleSeat(seat, selectedTier?.max_group_size ?? 4)
              }
              onSetSelectedSeats={booking.setSelectedSeats}
              onSetQuantity={(qty: number) =>
                booking.setQuantity(qty, selectedTier?.max_group_size ?? 4)
              }
              category={event.category}
              homeTeam={event.home_team}
              awayTeam={event.away_team}
            />
          )}

          {/* Payment step */}
          {booking.step === "payment" && selectedTier && (
            <>
              {isDemoTier(selectedTier.id) && (
                <div className="flex items-center gap-3 bg-amber-600/10 border border-amber-600/20 rounded-xl px-4 py-3 mb-4">
                  <Info className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    데모 모드입니다. 실제 결제가 진행되지 않습니다.
                  </p>
                </div>
              )}
              <ActionPanel
                event={event}
                tier={selectedTier}
                selectedSeats={booking.selectedSeats}
                quantity={booking.quantity}
                holdId={booking.holdId}
                onAuthRequired={() =>
                  guestEligible
                    ? setShowGuestModal(true)
                    : setShowAuthModal(true)
                }
              />
            </>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Bottom bar: summary + navigation */}
      <div className="flex flex-col lg:flex-row gap-4">
        {(booking.selectedTierId || booking.selectedSeats.length > 0) && (
          <div className="flex-1">
            <BookingSummary
              eventTitle={event.title}
              session={selectedSession}
              tier={selectedTier}
              selectedSeats={booking.selectedSeats}
              quantity={booking.quantity}
              holdExpiresAt={booking.holdExpiresAt}
              onHoldExpire={handleHoldExpire}
              isAssigned={isAssigned}
              category={event.category}
              homeTeam={event.home_team}
              awayTeam={event.away_team}
              subjectName={event.subject_name}
              eventDateEnd={event.event_date_end}
            />
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center gap-3 shrink-0">
          {currentStepIdx > 0 && (
            <Button
              variant="outline"
              onClick={handlePrev}
              disabled={isHolding}
              className="rounded-full px-6 border-border text-muted-foreground hover:bg-muted"
            >
              이전
            </Button>
          )}

          {booking.step !== "payment" && (
            <Button
              onClick={handleNext}
              disabled={!booking.canProceed || isHolding}
              className="rounded-full px-8 bg-primary hover:brightness-110 text-white shadow-lg shadow-[rgba(10,10,10,0.3)]"
            >
              {isHolding ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {getOrganizerLabels(event.category).ticketNoun}{" "}
                  {t("holding")}
                </span>
              ) : activeSteps[currentStepIdx + 1] === "payment" ? (
                t("payment")
              ) : (
                t("next")
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Auth modal for login gate */}
      <AuthModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={handleAuthSuccess}
        returnUrl={`/events/${event.id}`}
      />

      {/* Guest checkout modal — 비회원 구매(게스트 허용 이벤트/티어) */}
      {selectedTier && guestEligible && (
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
    </div>
  );
}
