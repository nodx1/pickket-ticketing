import { getOrganizerFeePlan } from "@/lib/v2/commerce-client";
import type { FeePlanType } from "@/lib/types";

export interface FeePlan {
  id: string;
  feeType: FeePlanType;
  feePercentage: number;
  feeFixed: number;
  minFee: number;
  maxFee: number | null;
}

export function calculatePlatformFee(plan: FeePlan, orderAmount: number): number {
  const safeAmount = Math.max(orderAmount, 0);

  // 방어: BIGINT 컬럼(fee_fixed/min_fee/max_fee)은 node-pg가 문자열로 반환하므로
  // 산술 전에 반드시 숫자화한다. 누락 시 `number + string` = 문자열 연결로
  // 수수료가 ~1000배 오염되어 저장된다(예: 300 + "300" = "300300"). (감사 P0)
  const feePercentage = Number(plan.feePercentage);
  const feeFixed = Number(plan.feeFixed);
  const minFee = Number(plan.minFee);
  const maxFee = plan.maxFee === null ? null : Number(plan.maxFee);

  let result = 0;

  if (plan.feeType === "percentage") {
    result = Math.round((safeAmount * feePercentage) / 100);
  } else if (plan.feeType === "fixed") {
    result = feeFixed;
  } else {
    result = Math.round((safeAmount * feePercentage) / 100) + feeFixed;
  }

  result = Math.max(result, minFee);
  return maxFee !== null ? Math.min(result, maxFee) : result;
}

/**
 * 계정(=organizer)의 유효 수수료 플랜 — **정본은 v2 `fee_schedules`**.
 *
 * ── 레벨2 컷오버 T3 ──
 * 예전엔 go `platform_fee_plans INNER JOIN accounts` 를 읽었다. accounts 가 비워지면서
 * 이 조회가 항상 NULL 이 되어 **플랫폼 수수료가 0원으로 계산**되던 경로다(정산 붕괴).
 * 이제 v2 가 유효 스케줄(organizer scope → 없으면 플랫폼 기본)을 내려준다.
 *
 * 🔴 fail-closed: v2 조회가 실패하면 **에러를 그대로 전파**한다. "조회 실패 → 수수료 0" 으로
 *    흘리면 주문이 수수료 0원으로 확정돼 정산이 틀어지고, 사후 복구가 사실상 불가능하다.
 *    호출측(checkout 등)은 이 예외를 붙잡아 결제를 중단시켜야 한다.
 *
 * @returns 유효 플랜이 없으면 null(= 수수료 정책 미설정. 호출측이 정책적으로 판단).
 * @throws v2 조회 실패(V2CommerceError 등) — 절대 삼키지 말 것.
 */
export async function getAccountFeePlan(accountId: string): Promise<FeePlan | null> {
  const plan = await getOrganizerFeePlan(accountId);
  if (!plan) return null;

  // 데이터 경계 정규화: v2 응답은 JSON number 지만, 산술 전 숫자 고정을 유지한다.
  // (과거 BIGINT 문자열이 `number + string` 으로 수수료를 ~1000배 오염시킨 사고 방지 — 감사 P0)
  return {
    id: plan.id,
    feeType: plan.fee_type as FeePlanType,
    feePercentage: Number(plan.fee_percentage),
    feeFixed: Number(plan.fee_fixed),
    minFee: Number(plan.min_fee ?? 0),
    maxFee: plan.max_fee === null || plan.max_fee === undefined ? null : Number(plan.max_fee),
  };
}
