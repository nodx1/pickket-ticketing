"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Sparkles, Clock, MapPin, CreditCard, CheckCircle } from "lucide-react";
import { Button } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import type { MyEventStatus, SeatTier } from "@pickket/lib/api";

interface LotteryPaymentPanelProps {
  eventId: string;
  eventTitle: string;
  myStatus: MyEventStatus;
  tiers: SeatTier[];
  onPay: (orderId: string) => void;
  /** True while a payment confirmation modal is open / payment is in progress */
  paying?: boolean;
}

export default function LotteryPaymentPanel({
  eventId,
  eventTitle: _eventTitle,
  myStatus,
  tiers,
  onPay,
  paying = false,
}: LotteryPaymentPanelProps) {
  const router = useRouter();
  const t = useTranslations("booking.lotteryPaymentPanel");
  const [countdown, setCountdown] = useState("");
  const [expired, setExpired] = useState(false);

  const tier = tiers.find((t) => t.id === myStatus.lottery_tier_id);
  const price = tier ? tier.face_price || tier.base_price : 0;
  const totalAmount = price * myStatus.lottery_group_size;
  const orderId = myStatus.lottery_order_id;
  const deadline = myStatus.lottery_payment_deadline;
  const orderStatus = myStatus.lottery_order_status;
  // 완료 상태: confirmed(결제확정) + paid(capture 완료) 둘 다 — 'paid' 누락 시
  // 이미 결제한 당첨자에게 결제 버튼이 재노출되어 PG창까지 진입하는 결함(P2-C1).
  const isConfirmed = orderStatus === "confirmed" || orderStatus === "paid";

  // 카운트다운
  useEffect(() => {
    if (!deadline || isConfirmed) return;
    const target = new Date(deadline).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) {
        setCountdown(t("countdownExpired"));
        setExpired(true);
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(t("countdownFormat", { h, m, s }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, isConfirmed]);

  // 이미 결제 완료
  if (isConfirmed) {
    return (
      <div className="w-full lg:w-[420px] shrink-0 flex flex-col items-center justify-center border-l-0 lg:border-l border-border bg-background p-8 gap-4">
        <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-foreground">{t("confirmedTitle")}</h2>
        <p className="text-sm text-muted-foreground text-center">
          {t("confirmedDescription")}
        </p>
        <Button
          onClick={() => router.push("/mypage")}
          className="rounded-xl px-8"
        >
          {t("confirmedCta")}
        </Button>
      </div>
    );
  }

  // 기한 만료
  if (expired) {
    return (
      <div className="w-full lg:w-[420px] shrink-0 flex flex-col items-center justify-center border-l-0 lg:border-l border-border bg-background p-8 gap-4">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <Clock className="h-8 w-8 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="text-xl font-bold text-foreground">{t("expiredTitle")}</h2>
        <p className="text-sm text-muted-foreground text-center">
          {t("expiredDescription")}
          <br />
          {t("expiredSeatReleased")}
        </p>
        <Button
          variant="outline"
          onClick={() => router.push(`/events/${eventId}`)}
          className="rounded-xl px-8"
        >
          {t("expiredCta")}
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full lg:w-[420px] shrink-0 flex flex-col border-l-0 lg:border-l border-border bg-background overflow-y-auto">
      {/* 헤더 */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-xl font-bold text-foreground">
            {t("headerTitle")}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("headerSubtitle")}
        </p>
      </div>

      {/* 결제 기한 카운트다운 */}
      <div className="p-6 border-b border-border bg-amber-50/50 dark:bg-amber-900/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>{t("deadlineLabel")}</span>
          </div>
          <span className="text-lg font-bold text-amber-600 dark:text-amber-400 font-tabular">
            {countdown}
          </span>
        </div>
      </div>

      {/* 당첨 정보 */}
      <div className="p-6 border-b border-border space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
          <MapPin className="h-4 w-4" />
          <span className="font-bold text-foreground">{t("seatInfoTitle")}</span>
        </div>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("seatZone")}</span>
            <span className="font-bold">{tier?.name ?? "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("seatQuantityLabel")}</span>
            <span className="font-bold">{t("seatQuantityValue", { count: myStatus.lottery_group_size ?? 0 })}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("unitPrice")}</span>
            <span className="font-bold font-tabular">{formatKRW(price)}</span>
          </div>
          {myStatus.invested_ap > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("investedAp")}</span>
              <span className="text-muted-foreground line-through">
                {myStatus.invested_ap.toLocaleString()} AP
              </span>
            </div>
          )}
          <div className="h-px bg-border" />
          <div className="flex justify-between text-base">
            <span className="font-bold">{t("totalAmountLabel")}</span>
            <span className="font-bold text-primary font-tabular text-lg">
              {formatKRW(totalAmount)}
            </span>
          </div>
        </div>
      </div>

      {/* 안내 */}
      <div className="p-6 border-b border-border">
        <ul className="space-y-2 text-xs text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#10003;</span>
            {t("noticeRandomSeat")}
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#10003;</span>
            {t("noticeTicketConfirmed")}
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#10003;</span>
            {t("noticeSeatAutoRelease")}
          </li>
        </ul>
      </div>

      {/* 결제 버튼 */}
      <div className="p-6 mt-auto">
        <Button
          onClick={() => orderId && !paying && onPay(orderId)}
          disabled={!orderId || paying}
          className="w-full h-14 rounded-xl text-lg font-bold"
        >
          <CreditCard className="h-5 w-5 mr-2" />
          {t("payButton", { amount: formatKRW(totalAmount) })}
        </Button>
      </div>
    </div>
  );
}
