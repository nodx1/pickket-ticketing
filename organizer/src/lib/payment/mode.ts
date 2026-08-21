import { getRuntimeEnv } from "@/lib/env.server";

/**
 * 온라인 PG 결제가 "실제로 라이브" 인지 판단.
 *
 * mock 모드(TOSS_SECRET_KEY 미설정)에서는 실제 PG 승인이 일어나지 않으므로 데모/E2E 가
 * self-complete 경로를 사용한다. 실 PG(토스)가 연동되면(true) 온라인 결제는 반드시 토스
 * 결제창 → 서버 confirm(금액·승인 검증)을 거쳐야 하며 self-complete 를 금지한다.
 */
export function arePaymentsLive(): boolean {
  return Boolean(getRuntimeEnv("TOSS_SECRET_KEY"));
}

/** 온라인 PG 를 거쳐야 하는 결제수단 (offline/bank_transfer 는 수동 확정 허용) */
export const ONLINE_PAYMENT_METHODS = ["card", "toss", "kakaopay", "naverpay"] as const;
