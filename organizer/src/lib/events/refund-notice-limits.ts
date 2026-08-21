/**
 * 환불 안내 문구 제약 — **zod 를 import 하지 않는 파일**에 둔다.
 *
 * 🔴 왜 파일을 나누나 (검증 원칙 #14)
 * 상수를 `homepage-design-schema.ts` 에 두면, `"use client"` 컴포넌트가 그 상수 하나를
 * 가져오면서 **zod 전체를 클라이언트 번들로 끌고 온다.** 트리셰이킹은 신뢰할 수 없다.
 * (`DETAIL_CAPTION_MAX` 가 `lib/public/detail-image.ts` 에 있는 것과 같은 이유다)
 *
 * 스키마 쪽이 이 파일을 import 해서 쓴다 — 반대 방향이면 같은 문제가 생긴다.
 */

/**
 * 실제 요구 문구(기상 악화·9홀 기준)가 약 120자라 넉넉히 잡되,
 * 약관을 통째로 붙여넣어 구매 패널이 무너지는 것은 막는다.
 */
export const REFUND_NOTICE_MAX = 500;
