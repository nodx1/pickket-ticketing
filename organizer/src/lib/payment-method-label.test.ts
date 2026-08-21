import { describe, expect, it } from "vitest";
import { paymentMethodLabel } from "@/lib/constants";

/**
 * 결제수단 라벨 — **원문을 화면에 흘리지 않는다** (2026-08-01 실사고).
 *
 * 🔴 종전 호출부는 `LABELS[x] ?? String(x)` 였다. 미지값이 그대로 노출되는 구조라:
 *      · 완주 주문은 `nicepay` → 화면에 **영어 원문**
 *      · 결제수단 미정(null) → 화면에 문자열 **"null"**
 */
describe("paymentMethodLabel", () => {
  it("🔴 null 은 '미확인' — 문자열 'null' 이 화면에 나오면 안 된다", () => {
    expect(paymentMethodLabel(null)).toBe("미확인");
    expect(paymentMethodLabel(null)).not.toContain("null");
    expect(paymentMethodLabel(undefined)).toBe("미확인");
  });

  it("🔴 null 을 '현장결제' 로 부르지 않는다 — 그게 이번 결함이었다", () => {
    expect(paymentMethodLabel(null)).not.toBe("현장결제");
  });

  it("🔴 nicepay 가 **전용 라벨**로 나온다 (영어 원문도, '기타' 도 아니다)", () => {
    // ⚠️ 처음엔 `한국어인가` 만 봤는데, 라벨을 지워도 폴백이 "기타" 를 돌려줘서
    //    뮤테이션이 살아남았다. 완주 주문 전부가 "기타" 로 보이는 건 고친 게 아니다.
    //    v2→go 전파가 method 에 PG사명을 실어서 실결제 3건이 전부 이 값이다.
    const label = paymentMethodLabel("nicepay");
    expect(label).not.toBe("nicepay");
    expect(label).not.toBe("기타");
    expect(/[가-힣]/.test(label)).toBe(true);
  });

  it("🔴 nicepay 를 '카드' 라고 부르지 않는다 — 가상계좌도 같은 값으로 온다", () => {
    // 이 값은 **수단이 아니라 PG사명**이다. 나이스는 가상계좌도 지원하므로
    // "카드" 라고 단정하면 가상계좌 구매자에게 거짓 표시가 된다(적대검수 지적).
    const label = paymentMethodLabel("nicepay");
    expect(label).not.toContain("카드");
  });

  it("알려진 수단은 그대로 매핑된다", () => {
    expect(paymentMethodLabel("card")).toBe("신용카드");
    expect(paymentMethodLabel("bank_transfer")).toBe("무통장입금");
    expect(paymentMethodLabel("offline")).toBe("현장결제");
  });

  it("🔴 모르는 값도 원문을 흘리지 않는다", () => {
    expect(paymentMethodLabel("weird_provider_x")).toBe("기타");
    expect(paymentMethodLabel("weird_provider_x")).not.toContain("weird");
  });
});

/**
 * 🔴 초대권 표시는 **라벨 맵 밖**에서 판정한다 (2026-08-04)
 *
 * 초대권 발급이 go `orders.payment_method` 에 'offline' 을 적는다. 라벨을 「초대권」으로
 * 바꾸면 주최자 **수동 주문**(진짜 현장결제)이 초대권으로 둔갑해 정산 오해로 간다.
 * ⟹ 라벨 맵은 그대로 두고, 화면이 `detail.isInvitation` 으로 **따로** 갈라야 한다.
 */
describe("초대권 표시 — 라벨 맵을 오염시키지 않았는가", () => {
  it("🔴 offline 은 여전히 '현장결제' 다 (수동 주문의 정당한 값)", () => {
    expect(paymentMethodLabel("offline")).toBe("현장결제");
    expect(paymentMethodLabel("offline")).not.toContain("초대");
  });

  it("🔴 어떤 결제수단도 '초대권' 으로 매핑되지 않는다", () => {
    for (const m of ["offline", "free", "card", "bank_transfer", "nicepay", null, "x"]) {
      expect(paymentMethodLabel(m)).not.toContain("초대");
    }
  });
});

/**
 * 🔴 수동발권도 라벨 맵 밖에서 판정한다 (2026-08-04)
 *
 * 발권 라우트(`ticket-issuance/route.ts:106`)가 `paymentMethod:"offline"` 을 적는다.
 * 라벨을 「주최자 수동발권」으로 바꾸면 **주최자 수동 주문**(진짜 현장결제)이 둔갑한다.
 */
describe("수동발권 표시 — 라벨 맵을 오염시키지 않았는가", () => {
  it("🔴 어떤 결제수단도 '수동발권' 으로 매핑되지 않는다", () => {
    for (const m of ["offline", "free", "card", "bank_transfer", "nicepay", null, "x"]) {
      expect(paymentMethodLabel(m)).not.toContain("수동발권");
    }
  });

  it("🔴 offline 은 여전히 '현장결제' 다", () => {
    expect(paymentMethodLabel("offline")).toBe("현장결제");
  });
});
