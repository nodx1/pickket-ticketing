import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth/server-session";
import { paymentMethodLabel } from "@/lib/constants";
import { formatDate, formatKRW } from "@/lib/format";
import { calculateCancellationRefund, toLegacyPreview, toTiers } from "@/lib/refund/cancellation-fee";
import { getEventForRefund } from "@/lib/refund/policy";
import { getOrderDetail } from "@/lib/server/orders";
import { showsDepositConfirmAction } from "@/lib/orders/deposit-eligibility";
import { getEventSummary } from "@/lib/server/events";
import { OrderAttendeesManager } from "./_components/order-attendees-manager";
import { OrderDepositConfirmAction } from "./_components/order-deposit-confirm-action";
import { OrderInvoiceButton } from "./_components/order-invoice-button";
import { OrderItemsManager } from "./_components/order-items-manager";
import { OrderMemoForm } from "./_components/order-memo-form";
import { OrderRefundAction } from "./_components/order-refund-action";
import { resolveIssueSource } from "@/lib/orders/issue-source";

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "결제 대기",
  completed: "결제 완료",
  cancelled: "취소됨",
  refunded: "환불됨",
  partially_refunded: "부분 환불",
  expired: "만료됨",
};

type PageProps = {
  params: Promise<{ eventId: string; orderId: string }>;
};

export default async function OrderDetailPage({ params }: PageProps) {
  const { eventId, orderId } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const [detail, event, refundRulesResult] = await Promise.all([
    getOrderDetail(session.accountId, eventId, orderId),
    getEventSummary(eventId, session.accountId),
    // 커스텀 환불 규칙 — refund API 와 동일 헬퍼로 조회해 표시 예상액=실제 처리액 일치 (감사 P0-6).
    // ── W5-COMMERCE: 정본이 v2 `event_refund_policies` 로 이동 ──
    // 🔴 조회 실패를 "커스텀 정책 없음(=기본규칙)" 으로 흘리면 커스텀 정책 이벤트에서
    //    화면 예상액이 실제 환불액과 갈라진다. 실패는 아래에서 **금액을 감추고** 환불 버튼을
    //    막는다(틀린 숫자를 보여주느니 못 읽었다고 말한다). 페이지 전체를 죽이지는 않는다 —
    //    주문 정보 자체는 환불 정책과 무관하게 볼 수 있어야 한다.
    // 🔴 2026-07-31 (코덱스 감사) — 읽는 저장소를 환불 API 와 맞췄다.
    //    종전: `getEventRefundRules` → v2 `event_refund_policies`(**prod 0행**, 쓰는 화면 없음)
    //          + 옛 `calculateRefund`(시작시각·Math.floor·별도 기본표).
    //    그날 오후 환불 API 3곳만 새 계산기로 옮기고 **이 화면을 빼먹어서**, 주최자가
    //    화면에서 20,000원을 보고 승인하면 실제로는 17,500원이 지급됐다
    //    (25,000원 · 기본단계 · D-5 실측). 주석엔 "환불 API 와 동일 헬퍼" 라고 적혀
    //    있었는데 **한쪽만 옮긴 순간 그 주석이 거짓말이 됐다.**
    getEventForRefund(session.accountId, eventId).then(
      (evt) => ({ ok: true as const, tiers: toTiers(evt.cancellation_fee_tiers) }),
      () => ({ ok: false as const, tiers: undefined }),
    ),
  ]);
  if (!detail) {
    redirect(`/events/${eventId}/orders`);
  }
  if (!event) {
    redirect(`/events/${eventId}/dashboard`);
  }

  // 환불 예상액은 '잔여 결제액'(결제액 − 기 환불액) 기준이어야 백엔드(v2 paid − total_refunded)와
  // 일치한다. 전액 기준으로 계산하면 부분환불된 주문에서 화면값 > 실제 처리액이 된다(P2-C12).
  const alreadyRefunded = Number(detail.refundAmount ?? 0);
  const refundableBase = Math.max(Number(detail.paidAmount ?? 0) - alreadyRefunded, 0);
  const refundPolicy = refundRulesResult.ok
    ? toLegacyPreview(
        calculateCancellationRefund(refundRulesResult.tiers, event.startsAt, refundableBase, new Date()),
      )
    : {
        // 정책을 못 읽었다 = 얼마가 환불될지 모른다. 0% 를 "환불 불가 정책"으로 위장하지 않고
        // 라벨로 사실을 말한다. 버튼은 잠그되(canRefund=false), 실제 환불 API 도 독립적으로
        // 같은 조회를 하고 503 으로 끊으므로 이중 안전망이다.
        policyLabel: "환불 정책을 확인할 수 없습니다 (잠시 후 다시 시도해주세요)",
        refundPercent: 0,
        refundAmount: 0,
        canRefund: false,
      };

  // 무통장입금 입금대기 주문: 주최자 입금확정 대상 (감사 P0-F).
  //   구매자는 무통장을 self-complete 할 수 없어 pending 으로 남는다 → 여기서 실입금 확인 후 확정.
  // 🔴 결제수단만으로 판정하면 **카드 결제 이탈 주문에도 버튼이 뜬다**(go 는 소비자 체크아웃
  //    주문도 payment_method='offline' 로 적는다). 서버 게이트와 **같은 함수**로 판정한다.
  const isAwaitingDeposit = showsDepositConfirmAction({
    status: String(detail.status),
    paymentMethod: detail.paymentMethod == null ? null : String(detail.paymentMethod),
    hasPgPayment: (detail as { hasPgPayment?: boolean }).hasPgPayment,
  });
  const orderTotal = (detail.items as Array<{ totalAmount: number | string }>).reduce(
    (sum, item) => sum + Number(item.totalAmount ?? 0),
    0,
  );
  const vatAmount = (detail.items as Array<{ taxRate?: number; totalAmount: number | string }>).reduce((sum, item) => {
    const taxRate = Number(item.taxRate ?? 0);
    if (taxRate <= 0) {
      return sum;
    }
    return sum + Math.round(Number(item.totalAmount ?? 0) * (taxRate / (100 + taxRate)));
  }, 0);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">주문 상세</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">{String(detail.orderNumber)}</h2>
        <div className="mt-4">
          <OrderInvoiceButton eventId={eventId} orderId={orderId} />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">주문 정보</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>구매자: {String(detail.buyerName)}</p>
            <p>연락처: {String(detail.buyerPhone ?? "미입력")}</p>
            <p>이메일: {String(detail.buyerEmail)}</p>
            <p>
              결제수단:{" "}
              {/*
                🔴 초대권·수동발권은 **따로 판정**한다. 라벨 맵(PAYMENT_METHOD_LABELS)을
                고치면 안 된다 — 두 경로 모두 go orders 에 'offline' 을 적는데, 그건 주최자
                **수동 주문**(진짜 현장결제)의 정당한 값이기도 하다. 라벨을 바꾸면 수동 주문이
                둔갑해 발주처가 "현장에서 몇 건 결제받았나" 를 잘못 읽는다.

                우선순위: 초대권 → 수동발권 → 결제수단. 두 표식은 서로의 발급 경로가 심지
                않으므로 실제로 겹치지 않지만, 겹치면 초대권이 이긴다.

                === true 인 이유: undefined 는 **모름**이다(v2 앵커 미연결·구버전 응답).
                모르면 지금 그대로 둔다 — 아닌 주문을 그렇게 보이게 하는 쪽이 훨씬 비싸다.
              */}
              {(() => {
                // 🔴 판정·문구를 **목록과 같은 함수**에서 가져온다(`@/lib/orders/issue-source`).
                //    여기 조건을 다시 적으면 다음에 한쪽만 고쳐진다 — 오늘 v2ErrorCode 가 그렇게 죽어 있었다.
                const src = resolveIssueSource({
                  isInvitation: detail.isInvitation as boolean | null | undefined,
                  isManualIssue: detail.isManualIssue as boolean | null | undefined,
                });
                return src.kind === "sale"
                  ? paymentMethodLabel(detail.paymentMethod as string | null)
                  : src.label;
              })()}
            </p>
            <p>상태: {ORDER_STATUS_LABELS[String(detail.status)] ?? String(detail.status)}</p>
            {/*
              🔴 「결제창에서 나감」과 「결제 실패」를 가른다 (2026-08-10).
              주문 상태만 보면 둘 다 pending/expired 라 구분이 안 되고, 민원 하나를
              쫓는 데 v2 DB 를 파야 했다.
              ⚠️ 상태(status)는 그대로 두고 **한 줄만 더한다** — 상태 머신을 건드리면
                 정산·환불이 흔들린다. 표시할 게 없으면 아무것도 안 뜬다.
            */}
            {detail.paymentAttempt?.label ? (
              <p className="text-content-subtle">결제 진행: {detail.paymentAttempt.label}</p>
            ) : null}
            <p>주문일: {formatDate(String(detail.orderedAt))}</p>
            <p>결제금액: {formatKRW(Number(detail.paidAmount ?? 0))}</p>
            {alreadyRefunded > 0 ? (
              <p className="text-warning">
                기 환불액: {formatKRW(alreadyRefunded)} · 잔여 {formatKRW(refundableBase)}
              </p>
            ) : null}
            {vatAmount > 0 ? <p>부가세 (10%): {formatKRW(vatAmount)}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">주문 항목</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <OrderItemsManager
              items={(detail.items as Array<Record<string, unknown>>).map((item) => ({
                id: String(item.id),
                productName: String(item.productName),
                quantity: Number(item.quantity ?? 0),
                totalAmount: Number(item.totalAmount ?? 0),
                cancelledAt: item.cancelledAt ? String(item.cancelledAt) : null,
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">참석자 목록</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <OrderAttendeesManager
            eventId={eventId}
            orderId={orderId}
            attendees={(detail.attendees as Array<Record<string, unknown>>).map((attendee) => ({
              id: String(attendee.id),
              name: String(attendee.name),
              email: attendee.email ? String(attendee.email) : null,
              phone: attendee.phone ? String(attendee.phone) : null,
              ticketNumber: String(attendee.ticketNumber),
              status: String(attendee.status),
            }))}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <OrderMemoForm eventId={eventId} orderId={orderId} initialMemo={String(detail.memo ?? "")} />
        {isAwaitingDeposit ? (
          <OrderDepositConfirmAction eventId={eventId} orderId={orderId} amount={orderTotal} />
        ) : (
          <OrderRefundAction
            eventId={eventId}
            orderId={orderId}
            policyLabel={refundPolicy.policyLabel}
            refundPercent={refundPolicy.refundPercent}
            refundAmount={refundPolicy.refundAmount}
            canRefund={refundPolicy.canRefund}
          />
        )}
      </div>
    </div>
  );
}
