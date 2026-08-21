"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Heart, Minus, Plus, Scale, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { strikethroughPrice } from "@/lib/public/face-price";
import { formatKRW } from "@/lib/format";
import { readCheckoutJson } from "@/lib/checkout/read-json";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";
import { CheckoutProgress } from "./checkout-progress";
import { SeatMap, type SeatTierInfo } from "@/components/seats/SeatMap";
import { SeatMapLegend } from "@/components/seats/SeatMapLegend";
import { SeatMapErrorBoundary } from "@/components/seats/SeatMapErrorBoundary";
import { SeatHoldTimer } from "@/components/seats/SeatHoldTimer";
import { SeatViewPreviewSheet } from "@/components/seats/SeatViewPreviewSheet";
import { BestAvailableButton } from "@/components/seats/BestAvailableButton";
import { CompanionPickerDialog } from "@/components/seats/CompanionPickerDialog";
import { SeatCompareSheet } from "@/components/seats/SeatCompareSheet";
import { PrivacyConsentDialog, loadConsent } from "@/components/seats/PrivacyConsentDialog";
import { watchSeat } from "@/lib/seats/client";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import type { Seat, SeatTier } from "@/lib/seats/types";
import { trackFunnel } from "@/lib/analytics/seat-funnel";
import { formatWhenWhere } from "@/lib/public/event-when-where";

interface CheckoutTicketStepProps {
  event: {
    id: string;
    slug: string;
    title: string;
    /**
     * 🔴 결제 직전까지 "언제·어디서" 를 못 보고 있었다 (2026-08-01 감사 P1-①).
     * 행사명과 금액만 있고 **일시·장소는 완료 페이지에만** 나왔다.
     * 주중권/주말권처럼 **날짜로 갈리는 상품**에서는 잘못 산 걸 결제가 끝난 뒤에 안다.
     */
    startsAt?: string | null;
    venueName?: string | null;
    products: Array<{
      id: string;
      name: string;
      description: string | null;
      price: number | string;
      /** 정가(할인 전). 상세 페이지와 **같은 규칙**으로 취소선을 그린다 — `face-price.ts`. */
      facePrice?: number | null;
      stock: number | null;
      taxIncluded?: boolean;
      saleStartsAt?: string | null;
      saleEndsAt?: string | null;
      isOnSale?: boolean;
    }>;
    /**
     * 카드사 자동할인(T13) — `{ BC: { rate: 10 } }`. 없으면 undefined.
     * 있으면 프로모코드 입력 대신 **카드사 할인 안내**를 띄운다.
     * ⚠️ 할인율만 온다. 실제 적용 할인코드는 서버만 안다(클라 임의 적용 차단).
     */
    cardDiscounts?: Record<string, { rate: number }> | null;
    /**
     * 프로모코드 입력칸을 보여줄지. 서버가 판정한다(`lib/checkout/promo-availability.ts`).
     * 쓸 수 있는 코드가 하나도 없으면 false — 입력칸이 막다른 길이 되는 걸 막는다.
     * ⚠️ 판정 조회가 실패하면 서버가 `true` 를 준다(fail-open).
     */
    showPromoInput?: boolean;
  };
}

/** 카드사 코드 → 표시명. 지금은 비씨만 쓰지만 매핑으로 두어 확장에 열어둔다. */
const CARD_LABELS: Record<string, string> = { BC: "비씨카드" };

export function CheckoutTicketStep({ event }: CheckoutTicketStepProps) {
  // 🔴 결제 전에 「언제·어디서」를 보여준다 — 없으면 빈 문자열이라 줄을 안 그린다.
  const eventWhenWhere = formatWhenWhere(event.startsAt, event.venueName);
  const router = useRouter();
  // rate 가 유효한 항목만 — v2 가 rate 없는 설정은 걸러 보내지만 방어적으로 한 번 더.
  const cardDiscountEntries = Object.entries(event.cardDiscounts ?? {}).filter(
    ([, cfg]) => Number(cfg?.rate) > 0,
  );
  const {
    selectedItems,
    setSelectedItems,
    selectedSeatIds,
    setSelectedSeatIds,
    promoCode,
    discountAmount,
    setPromo,
    ensureCheckoutToken,
    resetForEvent,
  } = useCheckoutStore();
  const [promoInput, setPromoInput] = useState(promoCode ?? "");
  const [promoMessage, setPromoMessage] = useState<string | null>(null);

  // Phase 1.5 — 시야 미리보기 sheet
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSeat, setPreviewSeat] = useState<Seat | null>(null);
  const handleSeatLongPress = useCallback((seat: Seat) => {
    setPreviewSeat(seat);
    setPreviewOpen(true);
  }, []);

  // 트랙 1.8 / 1.10 / 7.17 / 7.18 — 신규 다이얼로그 토글
  const [companionOpen, setCompanionOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareItems, setCompareItems] = useState<Seat[]>([]);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [pendingWatchSeatId, setPendingWatchSeatId] = useState<string | null>(null);
  // SeatHoldTimer — hold 성공 시 expiresAt 설정
  const [holdExpiresAt, setHoldExpiresAt] = useState<string | null>(null);

  // 트랙 7.9 — funnel "view" step (페이지 진입 1회)
  useEffect(() => {
    trackFunnel(event.id, { step: "view" });
  }, [event.id]);

  // 레벨2 재감사3차 P1 — 이벤트별 체크아웃 컨텍스트 분리.
  // 전역 sessionStorage 스토어가 이전 행사의 장바구니/구매자정보/멱등토큰을 보유한 채
  // 다른 행사 체크아웃에 진입하면(딥링크·탭 재사용) 그 문맥이 새 행사로 새어 잘못된
  // event/티켓/금액 조합이 만들어진다. rehydrate 후 저장 eventId 가 다르면 컨텍스트 리셋.
  useEffect(() => {
    void useCheckoutStore.persist.rehydrate();
    resetForEvent(event.id);
  }, [event.id, resetForEvent]);

  const items = useMemo(
    () =>
      event.products.map((product) => {
        const selected = selectedItems.find((item) => item.productId === product.id);
        return {
          ...product,
          price: Number(product.price),
          quantity: selected?.quantity ?? 0,
        };
      }),
    [event.products, selectedItems],
  );

  const subtotalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalAmount = Math.max(subtotalAmount - discountAmount, 0);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const eventWithSeats = event as typeof event & {
    seatMap?: {
      id: string;
      seats: Array<{
        id: string;
        section: string;
        row: string;
        seatNumber: string;
        status: "available" | "held" | "reserved" | "blocked";
        tierId?: string | null;
      }>;
      tiers?: Array<{
        id: string;
        name: string;
        basePrice: number;
        viewImageUrl?: string | null;
        viewDescription?: string | null;
        viewRating?: number | null;
        distanceFromStage?: number | null;
        positionLabel?: string | null;
        colorHex?: string | null;
      }>;
    } | null;
  };

  // Phase 1.2 — SeatMap 에 전달할 등급 정보 (가격/색상)
  const tierInfos = useMemo<SeatTierInfo[]>(() => {
    return (eventWithSeats.seatMap?.tiers ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      price: t.basePrice,
      color: t.colorHex ?? undefined,
    }));
  }, [eventWithSeats.seatMap?.tiers]);

  // 시야 sheet 에 전달할 SeatTier 객체 lookup
  const previewTier: SeatTier | null = useMemo(() => {
    if (!previewSeat?.tierId) return null;
    const t = (eventWithSeats.seatMap?.tiers ?? []).find(
      (x) => x.id === previewSeat.tierId,
    );
    if (!t) return null;
    return {
      id: t.id,
      accountId: "",
      eventId: event.id,
      seatMapId: eventWithSeats.seatMap?.id ?? null,
      productId: null,
      name: t.name,
      capacity: 0,
      basePrice: t.basePrice,
      facePrice: t.basePrice,
      saleMode: "fixed_fcfs",
      viewDescription: t.viewDescription ?? null,
      distanceFromStage: t.distanceFromStage ?? null,
      viewRating: t.viewRating ?? null,
      viewImageUrl: t.viewImageUrl ?? null,
      positionLabel: t.positionLabel ?? null,
      resaleAllowed: false,
      resaleMaxPrice: 0,
      allowGroupTickets: false,
      maxGroupSize: 0,
      colorHex: t.colorHex ?? null,
      displayOrder: 0,
      metadata: {},
      createdAt: "",
      updatedAt: "",
    } satisfies SeatTier;
  }, [previewSeat, eventWithSeats.seatMap, event.id]);

  // SeatMap 컴포넌트에 전달할 안정된 Seat[] (useMemo로 참조 안정화 → 무한 루프 방지)
  const seatMapSeats = useMemo<Seat[]>(() => {
    const raw = eventWithSeats.seatMap?.seats ?? [];
    const mapId = eventWithSeats.seatMap?.id ?? "";
    return raw.map((s, idx) => ({
      id: s.id,
      accountId: "",
      seatMapId: mapId,
      tierId: s.tierId ?? null,
      section: s.section,
      row: s.row,
      seatNumber: s.seatNumber,
      status: s.status,
      productId: null,
      reservedOrderId: null,
      x: idx % 10,
      y: Math.floor(idx / 10),
      qualityScore: null,
      label: `${s.row}${s.seatNumber}`,
      isObstructed: false,
      heldBy: null,
      heldUntil: null,
      holdId: null,
      holdToken: null,
      createdAt: "",
      updatedAt: "",
    }));
  }, [eventWithSeats.seatMap?.id, eventWithSeats.seatMap?.seats]);

  function updateQuantity(productId: string, nextQuantity: number) {
    const nextItems = items
      .map((item) =>
        item.id === productId
          ? {
              productId: item.id,
              name: item.name,
              price: item.price,
              quantity: Math.max(0, nextQuantity),
            }
          : {
              productId: item.id,
              name: item.name,
              price: item.price,
              quantity: item.quantity,
            },
      )
      .filter((item) => item.quantity > 0);

    setSelectedItems(nextItems);
  }

  async function applyPromo() {
    const response = await fetch("/api/checkout/apply-promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: event.id,
        code: promoInput,
        totalAmount: subtotalAmount,
      }),
    });

    // HTML 응답 방어 — 파서 오류 문구가 그대로 노출되지 않게 한다.
    const payload = await readCheckoutJson<{
      data?: { discountAmount: number; promoCode: { code: string } };
      error?: string;
    }>(response, "checkout/seat-funnel");

    if (!response.ok || !payload.data) {
      setPromo(null, 0);
      setPromoMessage(payload.error ?? "프로모코드 적용에 실패했습니다");
      return;
    }

    setPromo(payload.data.promoCode.code, payload.data.discountAmount);
    setPromoMessage(`${payload.data.discountAmount.toLocaleString("ko-KR")}원 할인되었습니다.`);
  }

  const requiresSeatSelection = Boolean(eventWithSeats.seatMap?.seats?.length);
  const canProceed = selectedItems.length > 0 && (!requiresSeatSelection || selectedSeatIds.length === totalQuantity);

  // SeatMap 콜백 — 안정 참조 (무한 루프 방지) + 트랙 7.9 funnel "select"
  const handleSeatMapSelect = useCallback(
    (seats: Seat[]) => {
      setSelectedSeatIds(seats.map((s) => s.id));
      if (seats.length > 0) {
        trackFunnel(event.id, { step: "select", seatCount: seats.length });
      }
    },
    [setSelectedSeatIds, event.id],
  );

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <CheckoutProgress current={1} />
      <div className="mx-auto mt-6 max-w-4xl space-y-6">
        <Card className="border-border bg-card/95">
          <CardHeader>
            {/* 🔴 `CardTitle` 은 h3 라 이 페이지에 h1 이 하나도 없었다 (2026-07-31 실측).
                결제 3단계 전부 h3 로 시작해 화면낭독기가 문서 구조를 못 잡는다.
                제목 자체를 h1 으로 올린다 — 각 단계가 독립 페이지다. */}
            <CardTitle as="h1" className="text-3xl font-black tracking-[-0.04em] text-foreground">1단계 · 티켓 선택</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {items.map((product) => (
              <div
                key={product.id}
                className="flex flex-col gap-4 rounded-lg border border-border bg-muted p-5 lg:flex-row lg:items-center lg:justify-between"
              >
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{product.name}</h2>
                  {/* 🔴 "상품 설명이 없습니다." 를 구매자에게 보여주지 않는다 (2026-07-31).
                      주최자가 설명을 안 넣은 것은 **우리 사정**이고, 돈 내는 화면에서
                      빈칸을 굳이 말할 이유가 없다. 없으면 그 줄을 안 그린다. */}
                  {product.description ? (
                    <p className="mt-2 text-sm text-muted-foreground">{product.description}</p>
                  ) : null}
                  {/* 상세 페이지와 **같은 판정 함수**를 쓴다 — 두 화면이 갈리지 않게. */}
                  {(() => {
                    const face = strikethroughPrice(product.price, product.facePrice);
                    return face === null ? null : (
                      <p data-testid="face-price" className="mt-3 text-xs font-semibold text-muted-foreground line-through">
                        {formatKRW(face)}
                      </p>
                    );
                  })()}
                  <p className="mt-1 text-sm font-semibold text-primary">
                    {formatKRW(product.price)} {product.taxIncluded ? <span className="text-xs text-muted-foreground">(세금 포함)</span> : null}
                  </p>
                  {product.isOnSale === false ? <p className="mt-2 text-sm text-warning">판매 기간이 아닙니다</p> : null}
                </div>
                <div className="flex items-center gap-3 rounded-full border border-border bg-background px-3 py-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label="수량 감소"
                    disabled={product.isOnSale === false}
                    onClick={() => updateQuantity(product.id, product.quantity - 1)}
                  >
                    <Minus className="size-4" />
                  </Button>
                  <span className="min-w-8 text-center text-foreground">{product.quantity}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label="수량 증가"
                    disabled={product.isOnSale === false}
                    onClick={() => updateQuantity(product.id, product.quantity + 1)}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            {requiresSeatSelection ? (
              <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">좌석 선택</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {totalQuantity}개의 좌석을 선택해 주세요. 캔버스를 클릭하여 좌석을 고를 수 있습니다.
                    </p>
                  </div>
                  <p className="text-sm font-bold text-primary">{selectedSeatIds.length}/{totalQuantity}</p>
                </div>
                {/* Phase 1.3 — Best Available 버튼 노출 */}
                {totalQuantity > 0 && eventWithSeats.seatMap?.id ? (
                  <BestAvailableButton
                    eventId={event.slug}
                    mapId={eventWithSeats.seatMap.id}
                    quantity={totalQuantity}
                    onSelected={(seats) =>
                      setSelectedSeatIds(seats.map((s) => s.id))
                    }
                  />
                ) : null}
                {/* SeatHoldTimer: hold 성공 시 만료 카운트다운 */}
                {holdExpiresAt ? (
                  <SeatHoldTimer
                    holdExpiresAt={holdExpiresAt}
                    onExpire={() => {
                      setHoldExpiresAt(null);
                      setSelectedSeatIds([]);
                    }}
                    sticky
                    warnBeforeSec={30}
                  />
                ) : null}
                {/* SeatMapErrorBoundary: WebGL 크래시/PixiJS 에러 시 흰 화면 방지 */}
                <SeatMapErrorBoundary>
                  <SeatMap
                    eventId={event.slug}
                    seats={seatMapSeats}
                    maxSelectable={totalQuantity || 4}
                    onSelect={handleSeatMapSelect}
                    tiers={tierInfos}
                    onSeatLongPress={handleSeatLongPress}
                  />
                </SeatMapErrorBoundary>
                <SeatMapLegend tiers={[]} />
                <SeatViewPreviewSheet
                  open={previewOpen}
                  onOpenChange={setPreviewOpen}
                  seat={previewSeat}
                  tier={previewTier}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-border bg-card/95">
          <CardContent className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm text-muted-foreground">{event.title}</p>
              {eventWhenWhere ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{eventWhenWhere}</p>
              ) : null}
              {/*
                🔴 T13: 카드사 자동할인이 걸린 행사는 **프로모코드 입력을 숨기고** 안내로 바꾼다.
                   · 전역 제거가 아니라 **이벤트 단위 조건부**다 — 이 체크아웃은 모든 행사가
                     공유하므로 무조건 지우면 다른 주최자의 프로모코드 기능이 통째로 죽는다.
                   · 숨기는 이유: 할인이 이미 자동 적용되는데 코드 입력칸이 있으면
                     "코드를 또 넣어야 하나" 로 읽히고, v2 는 주문당 코드 1개만 허용해
                     실제로 넣어봐야 카드사 할인과 배타적이다(혼란만 남는다).
                   · 할인 적용은 결제수단 선택 단계에서 일어난다(카드사 전용 결제창 + 승인 후 재검증).
              */}
              {cardDiscountEntries.length > 0 ? (
                <div className="mt-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3">
                  {cardDiscountEntries.map(([card, cfg]) => (
                    <p key={card} className="text-sm font-semibold text-foreground">
                      {CARD_LABELS[card] ?? card}로 결제하시면 {cfg.rate}% 할인됩니다
                    </p>
                  ))}
                  <p className="mt-1 text-xs text-muted-foreground">
                    다음 단계에서 결제수단을 선택하면 할인 금액이 적용됩니다.
                  </p>
                </div>
              ) : event.showPromoInput === false ? null : (
                <>
                  <div className="mt-3 flex gap-3">
                    <input
                      className="h-11 w-full min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                      placeholder="프로모코드 입력"
                      value={promoInput}
                      onChange={(event) => setPromoInput(event.target.value.toUpperCase())}
                    />
                    <Button variant="outline" className="shrink-0" onClick={() => void applyPromo()}>
                      적용
                    </Button>
                  </div>
                  {promoMessage ? <p className="mt-2 text-sm text-muted-foreground">{promoMessage}</p> : null}
                </>
              )}
              <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-foreground">
                {formatKRW(totalAmount)}
              </p>
            </div>
            <Button
              className="min-w-40"
              disabled={!canProceed}
              onClick={() => {
                // 레벨2 P1: 체크아웃 진입 시 durable idempotency 토큰 1회 확보(재시도 dedup 시드).
                // 재감사3차 P1: eventId 결속 — 다른 행사 진입이면 컨텍스트 리셋+새 토큰(크로스-이벤트 차단).
                ensureCheckoutToken(event.id);
                trackFunnel(event.id, {
                  step: "checkout",
                  seatCount: selectedSeatIds.length,
                });
                router.push(`/e/${event.slug}/checkout/details`);
              }}
            >
              다음
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* 트랙 1.8 / 1.10 / 7.17 / 7.18 — 신규 다이얼로그 마운트 */}
      <CompanionPickerDialog
        open={companionOpen}
        onOpenChange={setCompanionOpen}
        eventSlug={event.slug}
        onAllocated={(result) => {
          setSelectedSeatIds(result.seatIds);
          setHoldExpiresAt(result.expiresAt);
          showSuccess(`${result.seatIds.length}석 인접 좌석을 잡았습니다`);
        }}
      />
      <SeatCompareSheet
        open={compareOpen}
        onOpenChange={setCompareOpen}
        items={compareItems.map((s) => ({ seat: s, tier: previewTier }))}
        onRemove={(seatId) => {
          setCompareItems((prev) => prev.filter((s) => s.id !== seatId));
        }}
        onClear={() => setCompareItems([])}
      />
      <PrivacyConsentDialog
        open={privacyOpen}
        onOpenChange={setPrivacyOpen}
        onAgreed={async () => {
          if (!pendingWatchSeatId) return;
          try {
            await watchSeat(event.slug, { seatId: pendingWatchSeatId });
            showSuccess("관심 좌석으로 등록했습니다");
          } catch (err: unknown) {
            showError(err instanceof Error ? err.message : "관심 좌석 등록 실패");
          } finally {
            setPendingWatchSeatId(null);
          }
        }}
      />
        {/* 🔴 좌석맵 온보딩 투어를 걷어냈다 (2026-07-31 prod 실측).
            조건 없이 렌더돼, 좌석맵이 **없는** 행사(KLPGA 일일권)의 결제 첫 화면에
            "핀치로 확대 · 두 손가락으로 좌석맵을 확대/축소" 5단계 안내가 떴다.
            구매자는 있지도 않은 좌석맵을 찾게 되고, 돈을 내기 직전 화면에서
            **제품이 자기 상태를 모른다는 인상**을 준다.
            게다가 투어의 「다음」 버튼이 체크아웃의 「다음」과 충돌해 E2E 가
            `dismissOnboardingTour()` 로 **매번 끄고** 돌고 있었다 — 아무도 안 보는 UI 를
            테스트가 우회하며 유지하고 있던 셈이다. 되살리려면 좌석 행사 한정으로. */}

      {/* 트리거 버튼 — 좌석 선택 영역 위에 floating */}
      {requiresSeatSelection ? (
        <div className="pointer-events-none fixed bottom-20 right-4 z-30 flex flex-col gap-2 lg:bottom-6">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="pointer-events-auto bg-card shadow-md"
            onClick={() => setCompanionOpen(true)}
          >
            <Users className="mr-1 size-4" aria-hidden /> 친구와 함께
          </Button>
          {compareItems.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-events-auto bg-card shadow-md"
              onClick={() => setCompareOpen(true)}
            >
              <Scale className="mr-1 size-4" aria-hidden /> 비교 ({compareItems.length})
            </Button>
          ) : null}
          {previewSeat ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-events-auto bg-card shadow-md"
              onClick={() => {
                const consent = loadConsent();
                if (!consent) {
                  setPendingWatchSeatId(previewSeat.id);
                  setPrivacyOpen(true);
                } else {
                  void watchSeat(event.slug, { seatId: previewSeat.id })
                    .then(() => showSuccess("관심 좌석으로 등록했습니다"))
                    .catch((err: unknown) =>
                      showError(err instanceof Error ? err.message : "등록 실패"),
                    );
                }
              }}
            >
              <Heart className="mr-1 size-4" aria-hidden /> 관심
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
