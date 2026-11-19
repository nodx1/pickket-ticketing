"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import Link from "next/link";
import {
  MapPin,
  Calendar,
  Share2,
  Heart,
  Tag,
  Clock,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@pickket/ui";
import { checkFavorite, toggleFavorite } from "@pickket/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@pickket/store";
import { CATEGORY_LABELS } from "@pickket/lib/constants";
import { pickImage } from "@pickket/lib";
import { getSamplePoster } from "@/lib/sample-posters";

interface ImmersiveHeroProps {
  title: string;
  imageUrl?: string | null;
  imageVariants?: Record<string, string> | null;
  category?: string;
  venue?: string | null;
  city?: string;
  date: string;
  dateEnd?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  onCTAClick?: () => void;
  status?: string;
  bidCount?: number;
  eventId?: string;
  isLottery?: boolean;
  hasLotteryEntry?: boolean;
  hasTicket?: boolean;
  biddingClosesAt?: string | null;
  biddingOpensAt?: string | null;
  lotteryStatus?: string | null;
  lotteryOrderId?: string | null;
  lotteryOrderStatus?: string | null; // expired/cancelled/payment_required/confirmed
  lotteryPhase?: "pre_apply" | "applying" | "closed" | "drawing" | "drawn";
  isSoldOut?: boolean;
  // myStatus(has_ticket / has_lottery_entry) fetch 완료 여부 — false 면 CTA placeholder
  myStatusLoaded?: boolean;
}

export function ImmersiveHero({
  title,
  imageUrl,
  imageVariants,
  category,
  venue,
  city,
  date,
  dateEnd,
  minPrice,
  maxPrice,
  onCTAClick,
  status,
  bidCount: _bidCount,
  eventId,
  isLottery,
  hasLotteryEntry,
  hasTicket,
  biddingClosesAt,
  biddingOpensAt,
  lotteryStatus,
  lotteryOrderId: _lotteryOrderId,
  lotteryOrderStatus,
  lotteryPhase,
  isSoldOut,
  myStatusLoaded: _myStatusLoaded = true,
}: ImmersiveHeroProps) {
  const t = useTranslations("event.immersiveHero");
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [liked, setLiked] = useState(false);
  const [toggling, setToggling] = useState(false);

  const { data: favoriteData } = useQuery({
    queryKey: ["favorite", eventId],
    queryFn: async () => {
      const res = await checkFavorite(eventId!);
      return res.data as { is_favorited: boolean };
    },
    enabled: !!eventId && !!user,
  });

  useEffect(() => {
    if (favoriteData) setLiked(favoriteData.is_favorited);
  }, [favoriteData]);

  const handleToggleFavorite = useCallback(async () => {
    if (!eventId) return;
    if (!user) {
      router.push("/auth");
      return;
    }
    if (toggling) return;
    setToggling(true);
    setLiked((prev) => !prev);
    try {
      const res = await toggleFavorite(eventId);
      setLiked(res.data.is_favorited);
    } catch {
      setLiked((prev) => !prev);
      toast.error(t("favoriteError"));
    } finally {
      setToggling(false);
    }
  }, [eventId, user, toggling, router]);

  const handleShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast.success(t("linkCopied"));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        await navigator.clipboard.writeText(url);
        toast.success(t("linkCopied"));
      }
    }
  };

  // timeZone 명시 — SSR(Node UTC) vs client(KST) hydration mismatch 방지
  const formattedDate = new Date(date).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Seoul",
  });

  const formattedDateEnd = dateEnd
    ? new Date(dateEnd).toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
        timeZone: "Asia/Seoul",
      })
    : null;

  const isSelling = status === "bidding_open" || status === "open";

  // 추첨 마감 카운트다운 — applying phase 에서만 표시
  // (closed/drawing/drawn 이후엔 phase_closes_at 제거되어 event.bidding_closes_at
  // 공연일 fallback 이 찍혀 "4일 23시간" 같이 이상한 값이 나옴)
  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!hasLotteryEntry) return;
    // phase 가 closed/drawing 이면 추첨 대기 — "곧 발표" 표시
    if (lotteryPhase === "closed" || lotteryPhase === "drawing") {
      setCountdown(t("announcingSoon"));
      return;
    }
    if (!biddingClosesAt) return;
    if (lotteryPhase && lotteryPhase !== "applying") return;
    const target = new Date(biddingClosesAt).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) {
        setCountdown(t("announcingSoon"));
        return;
      }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(d > 0 ? t("countdownDays", { d, h, m }) : t("countdownHours", { h, m, s }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [hasLotteryEntry, biddingClosesAt, lotteryPhase]);

  const formatPrice = (price: number) => `₩${price.toLocaleString("ko-KR")}`;

  return (
    <section className="w-full bg-background pt-16">
      <div
        className="mx-auto py-8 md:py-12"
        style={{ width: "min(1200px, calc(100% - 48px))" }}
      >
        <div className="flex flex-col md:flex-row gap-8 md:gap-12">
          {/* 왼쪽: 포스터 이미지 */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5 }}
            className="shrink-0 w-full md:w-[360px] lg:w-[400px]"
          >
            <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-muted shadow-lg">
              {/* eslint-disable-next-line @next/next/no-img-element -- 동적 src(외부 URL+로컬 fallback 혼용), next/image remotePatterns 설정 없이 fill 불가 */}
              <img
                src={
                  // 3:4 세로 히어로 → portrait 렌디션 우선, image_url, 최종 샘플.
                  pickImage(imageVariants, "portrait", imageUrl) ||
                  getSamplePoster(eventId || title)
                }
                alt={title}
                loading="eager"
                fetchPriority="high"
                className="absolute inset-0 w-full h-full object-cover"
              />
            </div>
          </motion.div>

          {/* 오른쪽: 텍스트 정보 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="flex-1 min-w-0 flex flex-col"
          >
            {/* 배지 */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-primary/10 text-primary border border-primary/20">
                {category ? (CATEGORY_LABELS[category.toLowerCase()] ?? CATEGORY_LABELS[category] ?? category) : t("categoryFallback")}
              </span>
              <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                {t("fairDistribution")}
              </span>
              {isSelling && (
                <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold rounded-full bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                  {t("ticketingInProgress")}
                </span>
              )}
            </div>

            {/* 타이틀 */}
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-black tracking-tight text-foreground mb-6 leading-tight [word-break:keep-all]">
              {title}
            </h1>

            {/* 정보 */}
            <div className="space-y-2 mb-6 text-sm">
              {venue && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="h-4 w-4 shrink-0" />
                  <span className="text-foreground">
                    {venue}
                    {city ? ` · ${city}` : ""}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-4 w-4 shrink-0" />
                <span className="text-foreground">
                  {formattedDate}
                  {formattedDateEnd ? ` ~ ${formattedDateEnd}` : ""}
                </span>
              </div>
              {(minPrice || maxPrice) && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Tag className="h-4 w-4 shrink-0" />
                  <span className="text-foreground font-semibold font-tabular">
                    {minPrice && maxPrice && minPrice !== maxPrice
                      ? `${formatPrice(minPrice)} ~ ${formatPrice(maxPrice)}`
                      : formatPrice(minPrice || maxPrice || 0)}
                  </span>
                </div>
              )}
            </div>

            {/* 공유 + 좋아요 */}
            {eventId && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="rounded-xl"
                  onClick={handleShare}
                  aria-label={t("share")}
                >
                  <Share2 className="h-4 w-4" />
                  {t("share")}
                </Button>
                <Button
                  variant={liked ? "destructive" : "outline"}
                  size="lg"
                  className="rounded-xl"
                  onClick={handleToggleFavorite}
                  aria-label={liked ? t("unlikeAriaLabel") : t("likeAriaLabel")}
                  aria-pressed={liked}
                >
                  <Heart className={`h-4 w-4 ${liked ? "fill-white" : ""}`} />
                  {t("like")}
                </Button>
              </div>
            )}

            {/* CTA — 당첨/응모대기/예매 분기 */}
            {/* ⚠️ FCFS 전환 후(isLottery=false)는 과거 lottery_entry 상태와 무관하게 */}
            {/* "예매하기" 노출 — 낙첨자/미결제자도 잔여 좌석 구매 가능해야 함 */}
            {/* 휴대폰·태블릿은 하단 고정 바(MobileStickyBottom)가 같은 버튼을 띄우므로 여기서는 숨긴다.
                하단 바가 없는 취소·종료 이벤트만 그대로 보여 준다. */}
            <div
              className={`mt-auto justify-end ${
                status === "cancelled" || status === "completed" ? "flex" : "hidden lg:flex"
              }`}
            >
              {/* myStatus 로딩 중에도 텍스트 있는 CTA 보장 — placeholder div 무한 표시 방지.
                  로딩 시엔 phase 기반 fallback("응모하기"/"예매하기"/"결과 확인") 즉시 노출,
                  fetch 끝나면 본인 상태 (당첨/응모완료/예매완료) 로 swap. */}
              {hasTicket ? (
                <Link
                  href="/mypage?tab=tickets"
                  className="rounded-xl px-20 h-14 flex items-center gap-2 bg-emerald-600 text-white text-lg font-bold hover:brightness-110 transition-all"
                >
                  <Check className="h-5 w-5" />
                  {t("ticketingComplete")}
                </Link>
              ) : isSoldOut && !hasLotteryEntry && lotteryStatus !== "won" ? (
                /* 좌석 매진 + 본인이 응모/당첨 안 한 일반 사용자 → "매진" 비활성 */
                <div className="rounded-xl px-16 h-14 bg-muted border border-border flex items-center justify-center">
                  <span className="text-lg font-bold text-muted-foreground">
                    {t("soldOut")}
                  </span>
                </div>
              ) : isLottery &&
                hasLotteryEntry &&
                lotteryStatus === "won" &&
                (lotteryOrderStatus === "expired" ||
                  lotteryOrderStatus === "cancelled") ? (
                /* 당첨 + 결제 만료/취소
                   - 매진이면 잔여석 없으니 "결제 기한 만료" 비활성
                   - 잔여석 있으면 "예매하기" 활성 (잔여 fcfs 진입 기회) */
                isSoldOut ? (
                  <div className="rounded-xl px-12 h-14 bg-muted border border-border flex items-center justify-center">
                    <span className="text-lg font-bold text-muted-foreground">
                      {t("paymentExpired")}
                    </span>
                  </div>
                ) : onCTAClick ? (
                  <Button
                    onClick={onCTAClick}
                    className="rounded-xl px-16 h-14 text-lg font-bold"
                  >
                    {t("book")}
                  </Button>
                ) : (
                  <div className="rounded-xl px-12 h-14 bg-muted border border-border flex items-center justify-center">
                    <span className="text-lg font-bold text-muted-foreground">
                      {t("paymentExpired")}
                    </span>
                  </div>
                )
              ) : isLottery &&
                hasLotteryEntry &&
                (lotteryStatus === "won" ||
                  (lotteryStatus === "pending" && countdown === t("announcingSoon"))) ? (
                <div className="rounded-xl px-12 h-14 bg-muted border border-border flex items-center justify-center">
                  <span className="text-lg font-bold text-muted-foreground">
                    {t("lotteryClosed")}
                  </span>
                </div>
              ) : isLottery &&
                hasLotteryEntry &&
                lotteryStatus === "pending" &&
                countdown ? (
                <div className="flex flex-col items-end gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t("untilLotteryClose")}
                  </span>
                  <div className="rounded-xl px-10 h-14 bg-muted border border-border flex items-center gap-2">
                    <Clock className="h-5 w-5 text-primary" />
                    <span className="text-lg font-bold text-foreground font-tabular">
                      {countdown}
                    </span>
                  </div>
                </div>
              ) : isLottery &&
                hasLotteryEntry &&
                lotteryStatus === "pending" ? (
                <div className="rounded-xl px-12 h-14 bg-muted border border-border flex items-center justify-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <span className="text-lg font-bold text-muted-foreground">
                    {t("lotteryEntered")}
                  </span>
                </div>
              ) : onCTAClick ? (
                (() => {
                  // M월 D일 HH:MM — 같은 날짜의 여러 phase 구분 위해 분까지 표시.
                  // KST 강제 변환 (SSR=UTC, client=KST 차이로 hydration mismatch 방지).
                  const fmtKDate = (iso?: string | null) => {
                    if (!iso) return "";
                    const utc = new Date(iso);
                    const kst = new Date(utc.getTime() + 9 * 60 * 60 * 1000);
                    const month = kst.getUTCMonth() + 1;
                    const day = kst.getUTCDate();
                    const hh = String(kst.getUTCHours()).padStart(2, "0");
                    const mm = String(kst.getUTCMinutes()).padStart(2, "0");
                    return `${month}월 ${day}일 ${hh}:${mm}`;
                  };
                  // lottery + 응모 완료자 → "당첨자 발표 - M월 D일" 비활성
                  if (
                    isLottery &&
                    hasLotteryEntry &&
                    lotteryPhase !== "drawn"
                  ) {
                    const announceDate = fmtKDate(biddingClosesAt);
                    return (
                      <Button
                        disabled
                        className="rounded-xl px-20 h-14 text-lg font-bold"
                      >
                        {announceDate
                          ? t("announceWinners", { date: announceDate })
                          : t("lotteryEntered")}
                      </Button>
                    );
                  }
                  // lottery 이벤트 — phase 기반 라벨/비활성
                  if (isLottery && lotteryPhase) {
                    // pre_apply → "응모 시작 - M월 D일" (opens_at 날짜)
                    if (lotteryPhase === "pre_apply") {
                      const opensDate = fmtKDate(biddingOpensAt);
                      return (
                        <Button
                          disabled
                          className="rounded-xl px-20 h-14 text-lg font-bold"
                        >
                          {opensDate
                            ? t("lotteryOpens", { date: opensDate })
                            : t("lotteryNotStarted")}
                        </Button>
                      );
                    }
                    const labels: Record<
                      string,
                      { text: string; disabled: boolean }
                    > = {
                      applying: { text: t("enterLottery"), disabled: false },
                      closed: { text: t("lotteryClosed"), disabled: true },
                      drawing: { text: t("drawingInProgress"), disabled: true },
                      drawn: { text: t("checkResults"), disabled: false },
                    };
                    const cfg = labels[lotteryPhase] ?? {
                      text: t("enterLottery"),
                      disabled: false,
                    };
                    return (
                      <Button
                        onClick={onCTAClick}
                        disabled={cfg.disabled}
                        className="rounded-xl px-20 h-14 text-lg font-bold"
                      >
                        {cfg.text}
                      </Button>
                    );
                  }
                  return (
                    <Button
                      onClick={onCTAClick}
                      className="rounded-xl px-20 h-14 text-lg font-bold"
                    >
                      {isLottery ? t("enterLottery") : t("book")}
                    </Button>
                  );
                })()
              ) : null}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
