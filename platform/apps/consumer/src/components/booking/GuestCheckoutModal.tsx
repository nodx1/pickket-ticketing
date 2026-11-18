"use client";

import { useState, useCallback, useRef } from "react";
import { currentLocale } from "@/lib/locale-path";
import { useRouter } from "next/navigation";
import { ShieldCheck, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
} from "@pickket/ui";
import {
  createGuestOrder,
  prepareGuestPayment,
  type EventDetail,
  type SeatTier,
  type SeatData,
  type GuestOrderItem,
  type GuestOrderCreateResponse,
} from "@pickket/lib/api";
import { isTossLive } from "@/lib/toss";
import { startPayment as runPayment } from "@/lib/pay";
import {
  type NicePayMethod,
  DEFAULT_NICE_METHOD,
  getNiceMethods,
  isNiceCardOnly,
  isNicePayMethodSelectable,
} from "@/lib/nicepay-methods";
import { useTossWidget } from "@/hooks/useTossWidget";
import { useGuestBooking } from "@/hooks/useGuestBooking";
import { GuestPaymentPhase } from "./_components/GuestPaymentPhase";
import { GuestBuyerForm } from "./_components/GuestBuyerForm";

interface GuestCheckoutModalProps {
  open: boolean;
  onClose: () => void;
  event: EventDetail;
  tier: SeatTier;
  quantity: number;
  selectedSeats?: SeatData[];
  holdId?: string | null;
  /** 로그인으로 전환하고 싶을 때(선택). */
  onSwitchToLogin?: () => void;
}

// 이메일 형식 최소 검증(서버가 엄격검증 — 여기선 UX 조기피드백만).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = "form" | "processing" | "payment" | "success";

/**
 * 게스트(비회원) 체크아웃 모달.
 * - 구매자 정보(email 필수·name·phone 선택·마케팅 수신동의) 수집
 * - createGuestOrder 로 주문 생성 → view_token sessionStorage 보관
 * - 0원(status=confirmed): 즉시 완료 화면
 * - 유료(status=payment_required): PG 결제
 *     · live(토스/나이스): prepareGuestPayment(view 토큰) → 회원과 동일한 lib/pay.startPayment
 *       로 결제창(토스 위젯·나이스 SDK) 호출 → successUrl(?guest=1) 리다이렉트 → success
 *       페이지가 view 토큰으로 confirmGuestPayment(토스) / 나이스는 v2 return 이 서버승인.
 *     · mock(키 미설정): startPayment 가 successUrl 로 즉시 리다이렉트(회원 mock 정합).
 */
export default function GuestCheckoutModal({
  open,
  onClose,
  event,
  tier,
  quantity,
  selectedSeats,
  holdId,
  onSwitchToLogin,
}: GuestCheckoutModalProps) {
  const t = useTranslations("guest.checkout");
  const router = useRouter();
  const { buyer, updateBuyer, persistViewToken } = useGuestBooking();

  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);
  // 유료 live 결제 단계에서 사용할 생성 주문(order_id + view_token).
  const [pendingOrder, setPendingOrder] =
    useState<GuestOrderCreateResponse | null>(null);
  const [agreedPay, setAgreedPay] = useState(false);
  // 나이스페이(구형) 결제수단 선택 — 회원과 동형(env provider=nicepay 일 때만 UI 노출).
  // 카드전용 게이팅(C2): 이벤트 allowed_pay_methods 로 노출 수단 제한.
  const niceProviderActive = isNicePayMethodSelectable();
  const niceMethods = getNiceMethods(event.allowed_pay_methods);
  const niceCardOnly = isNiceCardOnly(event.allowed_pay_methods);
  const showNiceMethods = niceProviderActive && !niceCardOnly;
  const [niceMethod, setNiceMethod] = useState<NicePayMethod>(DEFAULT_NICE_METHOD);
  const effectiveNiceMethod: NicePayMethod = niceCardOnly ? "CARD" : niceMethod;
  // paying: 렌더용(버튼 스피너·닫기차단). payLockRef: 동기 재진입 가드(빠른 더블클릭).
  const [paying, setPaying] = useState(false);
  const payLockRef = useRef(false);

  const unitPrice = tier.face_price ?? tier.base_price;
  const hasSeats = !!(selectedSeats && selectedSeats.length > 0);
  const effectiveQty = hasSeats ? selectedSeats!.length : quantity;
  const totalAmount = unitPrice * effectiveQty;
  const isFree = totalAmount <= 0;

  const emailValid = EMAIL_RE.test(buyer.email.trim());
  const canSubmit = emailValid && phase === "form";

  // 토스 결제위젯 — 결제 단계(payment) 진입 시에만 렌더(라이브·유료).
  const { widgetRef, ready: widgetReady } = useTossWidget(
    totalAmount,
    phase === "payment",
  );

  const resetAndClose = useCallback(() => {
    setPhase("form");
    setError(null);
    setCompletedOrderId(null);
    setPendingOrder(null);
    setAgreedPay(false);
    setNiceMethod(DEFAULT_NICE_METHOD);
    setPaying(false);
    payLockRef.current = false;
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!emailValid) {
        setError(t("errorEmailInvalid"));
        return;
      }
      setError(null);
      setPhase("processing");

      try {
        // 데모/가상 좌석 id(비-UUID) 는 제외 — 백엔드는 실 좌석 UUID 만 수용.
        const seatIds = hasSeats
          ? selectedSeats!
              .map((s) => s.id)
              .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id))
          : undefined;
        const hasRealSeats = !!(seatIds && seatIds.length > 0);
        const item: GuestOrderItem = {
          tier_id: tier.id,
          quantity: hasRealSeats ? seatIds!.length : effectiveQty,
          unit_price: unitPrice,
          ...(hasRealSeats ? { seat_ids: seatIds } : {}),
          ...(hasRealSeats && holdId ? { hold_id: holdId } : {}),
        };

        const res = await createGuestOrder({
          event_id: event.id,
          items: [item],
          guest_buyer: {
            email: buyer.email.trim(),
            name: buyer.name?.trim() || null,
            phone: buyer.phone?.trim() || null,
            marketing_opt_in: buyer.marketing_opt_in,
          },
          total_amount: totalAmount,
          idempotency_key: crypto.randomUUID(),
        });

        const created = res.data;
        persistViewToken(
          created.order_id,
          created.view_token,
          created.view_token_expires_at,
        );

        // 0원 즉시확정: PG 불필요 → 완료.
        if (created.status === "confirmed" || isFree) {
          setCompletedOrderId(created.order_id);
          setPhase("success");
          return;
        }

        // 유료 주문: PG 결제 단계로 전환(prepare→결제창은 handlePay 에서).
        // 회원과 동일한 흐름: prepareGuestPayment(view 토큰) → lib/pay.startPayment.
        setPendingOrder(created);
        setAgreedPay(false);
        setPaying(false);
        payLockRef.current = false;
        setPhase("payment");
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ||
          (err as { message?: string })?.message ||
          t("errorGeneric");
        setError(detail);
        setPhase("form");
      }
    },
    [
      emailValid,
      hasSeats,
      selectedSeats,
      tier.id,
      effectiveQty,
      unitPrice,
      holdId,
      event.id,
      buyer,
      totalAmount,
      isFree,
      persistViewToken,
      t,
    ],
  );

  const goToOrder = useCallback(() => {
    if (!completedOrderId) return;
    const locale = currentLocale();
    router.push(`/${locale}/guests/orders/${completedOrderId}`);
  }, [completedOrderId, router]);

  /**
   * 유료 게스트 결제 개시(payment 단계).
   * prepareGuestPayment(view 토큰) → 회원과 동일한 lib/pay.startPayment 로 provider 분기.
   * successUrl 에 guest=1 을 실어 success 페이지가 view 토큰으로 confirmGuestPayment 하도록 표식.
   * (나이스는 v2 return 이 서버승인하므로 confirm 불필요 — provider=nicepay 로 착지.)
   */
  const handlePay = useCallback(async () => {
    if (!pendingOrder || !agreedPay) return;
    if (payLockRef.current) return;
    payLockRef.current = true;
    setPaying(true);
    setError(null);

    const orderId = pendingOrder.order_id;
    const viewToken = pendingOrder.view_token;
    try {
      const locale = currentLocale();
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const successUrl = `${origin}/${locale}/payment/success?order=${encodeURIComponent(
        orderId,
      )}&guest=1`;
      const failUrl = `${origin}/${locale}/payment/fail?order=${encodeURIComponent(
        orderId,
      )}&guest=1`;

      await runPayment({
        orderId,
        orderName: event.title,
        amount: totalAmount,
        successUrl,
        failUrl,
        tossWidget: widgetRef.current,
        buyer: {
          name: buyer.name?.trim() || undefined,
          email: buyer.email.trim() || undefined,
          tel: buyer.phone?.trim() || undefined,
        },
        // 게스트 prepare 위임(view 토큰 소유증명). success/fail_url 은 나이스 mallReserved
        // 경로에서 v2 가 config URL 로 redirect 하므로 여기 값은 토스/ mock 경로용.
        prepare: (id) =>
          prepareGuestPayment(id, {
            view_token: viewToken,
            success_url: successUrl,
            fail_url: failUrl,
            // 나이스 provider 활성 시 pay_method 전달(카드전용도 CARD 명시). 토스는 서버가 무시.
            ...(niceProviderActive ? { pay_method: effectiveNiceMethod } : {}),
          }),
        onNiceError: (message) => {
          setError(message);
          setPaying(false);
          payLockRef.current = false;
        },
        // 나이스 goPay 팝업 닫힘/취소 → paying 고착 탈출. 주문은 pending 유지(재시도 허용).
        onNiceCancel: (message) => {
          setError(message ?? t("errorPaymentCanceled"));
          setPaying(false);
          payLockRef.current = false;
        },
      });
      // 정상 경로는 결제창/리다이렉트로 페이지를 떠난다(도달 시 mock 즉시 리다이렉트 포함).
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ||
        (err as { message?: string })?.message ||
        t("errorPayment");
      setError(detail);
      setPaying(false);
      payLockRef.current = false;
    }
  }, [
    pendingOrder,
    agreedPay,
    event.title,
    totalAmount,
    widgetRef,
    buyer,
    t,
    niceProviderActive,
    effectiveNiceMethod,
  ]);

  // 라이브 결제(위젯 미준비 시 결제 버튼 비활성) 판정.
  // 토스 라이브면 위젯 준비 전 결제 불가(나이스/mock 은 SDK/리다이렉트라 위젯 무관).
  const payDisabled = !agreedPay || (isTossLive() && !widgetReady) || paying;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // 처리 중·결제 진행(리다이렉트 대기) 중에는 닫기 차단.
        if (!v && phase !== "processing" && !paying) resetAndClose();
      }}
    >
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="inline-flex h-10 w-10 rounded-full bg-primary/10 items-center justify-center shrink-0">
              <ShieldCheck className="h-5 w-5 text-primary/70" />
            </div>
            <div>
              <DialogTitle className="text-lg text-foreground">
                {t("title")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground mt-0.5">
                {t("description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === "success" ? (
          <div className="space-y-4 pt-2 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-600/10 text-emerald-600 dark:text-emerald-400">
              <Check className="size-8" />
            </div>
            <div>
              <p className="font-bold text-foreground">{t("successTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("successBody")}
              </p>
            </div>
            <div className="rounded-xl bg-muted/60 border border-border p-3 text-left">
              <p className="text-xs text-muted-foreground">{t("successGuideTitle")}</p>
              <p className="mt-1 text-xs text-content-subtle">
                {t("successGuideBody")}
              </p>
            </div>
            <Button
              onClick={goToOrder}
              className="w-full rounded-full bg-primary hover:brightness-110 text-white"
            >
              {t("ctaViewOrder")}
            </Button>
          </div>
        ) : phase === "payment" ? (
          <GuestPaymentPhase
            eventTitle={event.title}
            tierName={tier.name}
            quantity={effectiveQty}
            totalAmount={totalAmount}
            widgetReady={widgetReady}
            agreedPay={agreedPay}
            paying={paying}
            payDisabled={payDisabled}
            error={error}
            showNiceMethods={showNiceMethods}
            niceMethods={niceMethods}
            niceMethod={niceMethod}
            onNiceMethodChange={setNiceMethod}
            niceCardOnly={niceProviderActive && niceCardOnly}
            provider={niceProviderActive ? "nicepay" : "toss"}
            onCancelProcessing={() => {
              // 나이스 goPay 팝업 닫힘 → paying 고착 탈출. 주문 pending 유지(재시도 허용).
              setError(t("errorPaymentCanceled"));
              setPaying(false);
              payLockRef.current = false;
            }}
            onAgreedChange={setAgreedPay}
            onPay={() => void handlePay()}
            onBack={() => {
              if (paying) return;
              setPhase("form");
              setError(null);
              setAgreedPay(false);
            }}
          />
        ) : (
          <GuestBuyerForm
            eventTitle={event.title}
            tierName={tier.name}
            quantity={effectiveQty}
            totalAmount={totalAmount}
            isFree={isFree}
            buyer={buyer}
            emailValid={emailValid}
            canSubmit={canSubmit}
            processing={phase === "processing"}
            error={error}
            onUpdateBuyer={updateBuyer}
            onSubmit={handleSubmit}
            onSwitchToLogin={
              onSwitchToLogin
                ? () => {
                    resetAndClose();
                    onSwitchToLogin();
                  }
                : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
