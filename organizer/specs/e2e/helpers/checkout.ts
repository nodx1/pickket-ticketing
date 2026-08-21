/**
 * checkout 헬퍼 — initiate/complete 쿠키 브리지.
 *
 * 배경:
 *  커밋 P0-5 이후 POST /api/checkout/complete 는 checkout/initiate 가 발급하는
 *  httpOnly 쿠키(pickket_last_order)로 주문 소유권을 검증한다.
 *  로컬 스택은 production 모드로 기동돼 Set-Cookie 에 Secure 플래그가 붙고,
 *  Playwright APIRequestContext 는 http:// 에서 Secure 쿠키를 자동 전송하지 않는다
 *  (RFC 6265bis — Secure 쿠키는 https 전용).
 *
 *  이 헬퍼는 initiate 응답의 Set-Cookie 헤더를 파싱해, complete 호출 시
 *  Cookie 헤더로 명시 전달함으로써 스택 환경(http/https)에 무관하게 동작한다.
 *
 * 사용법:
 *  const { orderId, ownerCookie } = await checkoutInitiate(request, payload);
 *  const res = await checkoutComplete(request, { orderId, paymentMethod: "offline" }, ownerCookie);
 */

import type { APIRequestContext, APIResponse } from "@playwright/test";

export interface InitiatePayload {
  eventId: string;
  items: Array<{ productId: string; quantity: number }>;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  finalAmount?: number;
  promoCode?: string;
  selectedSeatIds?: string[];
  source?: string;
  holdId?: string;
  holdToken?: string;
  answers?: Record<string, string | string[]>;
}

export interface InitiateResult {
  orderId: string;
  shortId: string;
  totalAmount: number;
  /** pickket_last_order 쿠키 값 — complete 호출 시 ownerCookie 로 전달 */
  ownerCookie: string;
  /** 원본 응답 — 추가 단언이 필요한 경우 */
  response: APIResponse;
}

/**
 * POST /api/checkout/initiate 를 호출하고, Set-Cookie 헤더에서
 * pickket_last_order 값을 추출해 ownerCookie 로 반환한다.
 */
export async function checkoutInitiate(
  request: APIRequestContext,
  payload: InitiatePayload,
): Promise<InitiateResult> {
  const res = await request.post("/api/checkout/initiate", { data: payload });
  const ownerCookie = extractOwnerCookie(res);
  const body = await res.json();
  return {
    orderId: body.data?.orderId ?? "",
    shortId: body.data?.shortId ?? body.data?.orderNumber ?? "",
    totalAmount: body.data?.totalAmount ?? 0,
    ownerCookie,
    response: res,
  };
}

/**
 * POST /api/checkout/complete 를 호출한다.
 * ownerCookie が 제공되면 Cookie 헤더에 주입해 http:// 환경에서도 Secure 쿠키가 전달되게 한다.
 */
export async function checkoutComplete(
  request: APIRequestContext,
  payload: { orderId: string; paymentMethod: string },
  ownerCookie: string,
): Promise<APIResponse> {
  return request.post("/api/checkout/complete", {
    data: payload,
    headers: ownerCookie ? { Cookie: `pickket_last_order=${ownerCookie}` } : {},
  });
}

/**
 * initiate APIResponse 에서 pickket_last_order 쿠키 값을 추출한다.
 * Set-Cookie 헤더가 없거나 쿠키가 없으면 빈 문자열 반환.
 */
export function extractOwnerCookie(res: APIResponse): string {
  // Playwright는 set-cookie 헤더를 소문자로 정규화한다.
  const raw: string = res.headers()["set-cookie"] ?? "";
  // 여러 Set-Cookie 가 있을 경우 줄바꿈/쉼표로 구분될 수 있음
  for (const part of raw.split(/\n|,(?=[^;])/)) {
    const nameVal = part.trim().split(";")[0];
    const eqIdx = nameVal.indexOf("=");
    if (eqIdx < 0) continue;
    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    if (name === "pickket_last_order") return value;
  }
  return "";
}
