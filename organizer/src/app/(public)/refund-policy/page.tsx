// 루트 layout 의 `title.template`("%s — PICKKET.GO")이 브랜드명을 붙인다.
// 🔴 여기에 브랜드명을 다시 쓰면 "… — PICKKET.GO — PICKKET.GO" 가 된다.
export const metadata = { title: "환불 정책" };

/**
 * 🔴 여기에 **구체적인 환불율을 박지 않는다** (2026-07-31 실사고).
 *
 * 종전엔 `D-10 100% · D-7 90% · D-3 80% · D-1 70% · 당일 불가` 가 박혀 있었다.
 * 그런데 환불율은 **행사별**(`events.cancellation_fee_tiers`)이고, 실제 prod 값은
 * 이 표와 달랐다 — 구매자가 80% 라고 보고 50% 를 받는 상태였다.
 * 이 페이지는 특정 행사를 모르므로 **숫자를 약속할 수 없다.** 어디서 보는지만 알린다.
 * (행사 상세·환불 신청 화면은 `lib/refund/policy-display.ts` 로 DB 값을 그린다)
 */
const items = [
  "환불 규정은 행사마다 다릅니다 — 각 행사 상세 페이지의 '환불 정책' 을 확인해 주세요.",
  "환불 신청 화면에서 해당 티켓에 적용되는 환불율과 금액을 먼저 보여드립니다.",
  "결제수단·결제사 사정에 따라 실제 입금까지 영업일 기준 3~7일이 걸릴 수 있습니다.",
];

export default function RefundPolicyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <div className="rounded-xl border border-border bg-card/95 p-8">
        <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">환불정책</h1>
        <div className="mt-8 space-y-4 text-sm text-muted-foreground">
          {items.map((item) => (
            <div key={item} className="rounded-lg border border-border bg-muted px-4 py-4">
              {item}
            </div>
          ))}
          <p className="leading-7">
            환불 요청은 주문 상세 또는 고객센터를 통해 접수할 수 있으며, 무료 이벤트와 천재지변 등 예외 상황은 이벤트별 고지사항을 따릅니다.
          </p>
        </div>
      </div>
    </div>
  );
}
