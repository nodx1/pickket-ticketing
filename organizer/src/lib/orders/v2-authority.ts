/**
 * v2 권위 판정 — "go 가 자기 시계로 결정해도 되는가" 를 한 곳에서 답한다.
 *
 * ## 🔴 왜 필요한가 (2026-07-31 실사고)
 * v2→go 결제확정 전파가 **한 번도 도달한 적이 없었다**(go·v2 양쪽 감사원장 0행).
 * 그 사이 go 는 자기 `expires_at` 만 보고 **결제 완료된 주문을 만료**시켰고
 * (`ORD-260731-002`: v2 confirmed·티켓 active 인데 go expired·참석자 cancelled),
 * 같은 판정이 `state-changed` 에서는 **자동 전액환불**로 이어진다
 * (`compensation.ts` → `refundOrder({full:true})` = 실 PG 취소).
 *
 * 뿌리는 하나다 — **Order status 는 v2 SSOT 인데 go 가 자기 시계를 권위로 취급**했다.
 * 그래서 만료/환불처럼 **되돌릴 수 없는** 판단 앞에서는 반드시 v2 에 물어본다.
 *
 * ## 계약
 * - **fail-closed**: v2 에 못 물어보면 "만료해도 된다" 고 답하지 않는다.
 *   못 죽이는 쪽이 안전하다 — 안 죽인 주문은 다음 tick 이 다시 본다.
 *   잘못 죽인 주문은 참석자 취소·환불까지 번지고 되돌리기 어렵다.
 * - 판정 근거를 항상 함께 돌려준다(로그·감사용). "왜 안 죽였나" 를 말할 수 없으면
 *   조용한 스킵과 구분되지 않는다.
 */
import { getOrderByExternalRef, V2CommerceError } from "@/lib/v2/commerce-client";

/**
 * v2 `OrderStatus` enum(`platform/backend/app/models/order.py`) 전량을 셋으로 가른다.
 *
 * 🔴 **enum 을 다 덮어야 한다.** 빠진 값은 `unknown` 이 되고, `unknown` 은 fail-closed 라
 * 아무 일도 안 하면서 **경보만 울린다**. 실제로 `payment_required` 를 빠뜨려
 * "결제 진행 중인 모든 정상 주문" 이 5분마다 degraded 경보를 내는 상태였다 —
 * 대회 중에 그러면 **진짜 유실 신호가 그 소음에 묻힌다**.
 */

/** 결제가 유효하다 — go 는 만료·보상환불을 해선 안 된다. repair 대상. */
const V2_LIVE_PAID_STATUSES = new Set(["confirmed", "paid", "partially_refunded"]);

/** v2 가 이미 끝냈다 — go 앵커를 맞춰도 안전하다. */
const V2_TERMINAL_STATUSES = new Set([
  "expired", "cancelled", "refunded", "deposit_refunded", "deposit_forfeited",
]);

/**
 * 아직 결제 전이다 — **정상 진행 중**. 만료도 repair 도 하지 않지만 **경보 대상이 아니다**.
 *
 * go 가 자기 `expires_at` 으로 먼저 만료시키면 v2 와 어긋난다. v2 reap 이 이 주문을
 * `expired` 로 만들면 그때 go 도 따라간다(SSOT 순서). 그 사이 go 앵커가 잠깐 뒤처지는 것은
 * 정상이며, 그것 때문에 크론을 degraded 로 만들면 안 된다.
 */
const V2_IN_FLIGHT_STATUSES = new Set([
  "pending", "payment_required", "authorized", "deposit_held",
]);

/**
 * v2 가 아는 결제 사실. **repair 가 go 앵커에 적을 값**이다.
 *
 * 🔴 2026-07-31 배포 후 실측으로 드러남: 대사 경로가 이걸 안 넘겨서, 복구된 주문이
 *    `paid_amount=0` · `payment_method=offline` 로 남았다(실제 15,000원 카드 결제).
 *    정산·CS 조회가 그 값을 본다. `state-changed` 경로만 고치고 대사를 놓친 결과다.
 *    ⟹ 판정에 **같이 실어 보낸다** — 이미 받아온 응답에서 뽑으므로 추가 왕복이 없다.
 */
export interface V2PaymentFacts {
  amount: number | null;
  method: string | null;
}

export type V2Verdict =
  /** v2 가 결제를 유효로 본다 — 만료·보상환불 금지. repair 대상. */
  | { kind: "paid"; v2OrderId: string; v2Status: string; facts: V2PaymentFacts }
  /** v2 도 끝난 것으로 본다 — go 앵커를 맞춰도 된다. */
  | { kind: "terminal"; v2OrderId: string; v2Status: string }
  /** 아직 결제 전 — 정상. 아무것도 하지 않고 **경보도 울리지 않는다**. */
  | { kind: "in_flight"; v2OrderId: string; v2Status: string }
  /** v2 에 주문이 없다 — go 단독 주문(무통장 등). 종전 동작 유지. */
  | { kind: "absent" }
  /** 물어보지 못했다 — 🔴 fail-closed. 아무것도 하지 않는다. */
  | { kind: "unknown"; reason: string };

/**
 * go 주문 id 로 v2 의 판단을 묻는다.
 *
 * ⚠️ 404(ORDER_NOT_FOUND)와 그 밖의 실패를 **반드시 구분**한다.
 * 404 는 "v2 에 없다"(무통장 등 go 단독 주문)라는 **정보**이고,
 * 타임아웃·5xx 는 **정보 없음**이다. 둘을 뭉치면 v2 장애 중에 결제된 주문이
 * "v2 에 없는 주문" 으로 취급돼 그대로 만료된다.
 */
export async function askV2AboutOrder(goOrderId: string): Promise<V2Verdict> {
  try {
    const detail = await getOrderByExternalRef(goOrderId);
    const status = String(detail.status_v2 ?? detail.status ?? "").trim().toLowerCase();
    if (V2_LIVE_PAID_STATUSES.has(status)) {
      const amount = Number(detail.paid_amount ?? detail.total_amount);
      return {
        kind: "paid",
        v2OrderId: detail.order_id,
        v2Status: status,
        facts: {
          amount: Number.isFinite(amount) && amount > 0 ? amount : null,
          method: detail.payment_method ?? null,
        },
      };
    }
    if (V2_TERMINAL_STATUSES.has(status)) {
      return { kind: "terminal", v2OrderId: detail.order_id, v2Status: status };
    }
    if (V2_IN_FLIGHT_STATUSES.has(status)) {
      return { kind: "in_flight", v2OrderId: detail.order_id, v2Status: status };
    }
    // 세 목록 어디에도 없는 값 = v2 가 새 상태를 추가했다. **모른다**로 둔다 —
    // 임의로 "끝났다" 로 해석하면 그날부터 조용히 파괴적으로 동작한다.
    return { kind: "unknown", reason: `v2 상태 미지: ${status || "(빈값)"}` };
  } catch (e: unknown) {
    if (e instanceof V2CommerceError && e.status === 404) {
      return { kind: "absent" };
    }
    return {
      kind: "unknown",
      reason: e instanceof Error ? e.message : "v2 조회 실패",
    };
  }
}

/**
 * 만료시켜도 되는가. **`true` 는 "v2 가 끝났다고 확인해 줬다" 일 때만.**
 *
 * `absent`(v2 에 없는 go 단독 주문)도 허용한다 — 무통장 주문은 v2 앵커 없이
 * go 에서만 만료되는 것이 종전 동작이고, 그걸 막으면 미입금 주문이 영원히 남는다.
 */
export function mayExpire(verdict: V2Verdict): boolean {
  return verdict.kind === "terminal" || verdict.kind === "absent";
}
