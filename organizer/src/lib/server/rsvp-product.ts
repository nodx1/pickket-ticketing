/**
 * 이벤트별 전용 **숨김·0원 티켓 상품**(RSVP 참석등록 / 초대권·수동발권) resolve-or-create.
 *
 * 배경(감사 P1-8): RSVP 접수·수동발권·CSV 임포트 3경로는 orders/attendees 를 직접 INSERT 해
 *   커머스 SSOT 를 우회했다. 표준 `createOrder`(v2 write-through) 경유로 통일하려면 주문이 참조할
 *   tier 가 필요한데, 무료 발권(0원)은 v2 가 유료 tier 에 0원 주문을 거부하므로(AMOUNT_MISMATCH)
 *   **판매 상품과 별개인 숨김 0원 tier** 를 이벤트당 1개 보장한다.
 *
 * ## 레벨2 컷오버 wave2 (W2-PS) — go `products` 폐기
 * 이전엔 go `products` 에 마커 행(type=ticket·price=0·visibility=hidden·name)을 만들고 advisory
 * lock 으로 이중생성을 막은 뒤, 그 id 를 v2 tier `external_ref` 로 write-through 했다.
 * 이제 go 테이블이 없으므로 **external_ref 자체를 결정적으로 파생**한다:
 *
 *     external_ref = `freeprod:{eventId}:{slug(name)}`
 *
 * ### 멱등성 — "동시 2회 실행하면?"
 * 두 요청이 같은 external_ref 를 계산한다 → v2 `ix_seat_tiers_external_ref` UNIQUE + upsert 가
 * **같은 tier 한 행**으로 수렴한다. 락이 필요 없어졌다(락은 원래 랜덤 UUID 를 두 번 만들지 않기
 * 위한 것이었고, 결정적 키에는 그 문제가 없다).
 *
 * ### 트랜잭션 경계 — "외부호출 후 crash 하면?"
 * 로컬 write 가 아예 없다. v2 upsert 가 성공하면 그 상태가 정본이고, crash 후 재시도는 같은
 * external_ref 로 같은 tier 를 다시 얻는다(부작용 0). 호출부는 반환된 productId 로 주문을 만든다.
 *
 * ### 반환 id 계약
 * 반환하는 `productId` = external_ref 다. 호출부(주문 항목의 product_id)가 쓰는 값이 곧 v2 tier 의
 * external_ref 라 종전(go product UUID)과 **동일한 해석**을 유지한다.
 */
import crypto from "node:crypto";

import type { Pool } from "pg";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";
import {
  loadCatalog,
  saveCatalogEntry,
  toProductUpsert,
  UNLIMITED_TIER_CAPACITY,
} from "@/lib/v2/tier-catalog";

/**
 * 무료상품 ref 파생용 고정 네임스페이스(UUID v5). 값 자체에 의미는 없고 **바뀌면 안 된다** —
 * 바꾸면 기존 이벤트의 RSVP/초대권 상품이 새 id 로 갈라져 과거 주문과 연결이 끊긴다.
 */
const FREE_PRODUCT_NAMESPACE = "6f9b1f2e-2d1a-4c6f-9f3a-1c5b8e0d7a41";

/** RFC 4122 UUID v5(SHA-1). 외부 의존 없이 결정적 id 를 만든다. */
function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 결정적 상품 id(= v2 external_ref).
 *
 * ⚠️ **왜 UUID 형태인가** — 순수 문자열(`freeprod:{eventId}:comp`)이 계약상 더 읽기 쉽지만,
 * go 잔존 경로(`lib/server/orders.ts` `ensureProducts` 의 `id = ANY($3::uuid[])`)와
 * `order_items.product_id`(uuid 컬럼)가 아직 UUID 를 요구한다. UUID v5 면 **결정적이면서**
 * 그 타입 계약을 깨지 않아, W2-ORD 트랙이 주문 경로를 v2 카탈로그로 옮길 때까지의 실패 모드가
 * "Postgres 캐스트 에러(500)"가 아니라 깨끗한 404 로 유지된다.
 */
export function freeProductRef(eventId: string, name: string): string {
  const slug = name === RSVP_PRODUCT_NAME ? "rsvp" : name === COMP_PRODUCT_NAME ? "comp" : "other";
  return uuidV5(`freeprod:${eventId}:${slug}`, FREE_PRODUCT_NAMESPACE);
}

/**
 * @param capacity v2 tier capacity 상한. 미지정 시 사실상 무제한. F2 는 이벤트별 comp 캡을 넘긴다.
 *   상한은 v2 tier capacity 로 집행되어 발권 초과가 v2 에서 원자적으로 거부된다.
 *   ⚠️ 캡은 tier **최초 생성 시점**에만 반영된다(이미 있으면 기존 capacity 유지) — 종전과 동일.
 * @returns 상품 id(= v2 external_ref). 이벤트 미소유/미존재·v2 장애 시 `null`
 *   (호출부가 재시도 가능한 오류로 처리 — 종전 계약 유지).
 */
async function ensureFreeProduct(
  _pool: Pool | null,
  eventId: string,
  accountId: string,
  name: string,
  description: string,
  capacity: number = UNLIMITED_TIER_CAPACITY,
): Promise<{ productId: string } | null> {
  // 부모 이벤트 소유 확인 + v2 canonical id. 테넌트 경계는 v2 organizer_ref 가 강제한다.
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(eventId, accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) return null; // v2 장애 = 재시도 가능(종전 null 계약)
    throw err;
  }
  if (!v2EventId) return null;

  const ref = freeProductRef(eventId, name);

  try {
    // 이미 있으면 capacity 를 덮지 않는다(위 @param 주석의 "최초 생성 시점" 계약).
    const existing = (await loadCatalog(v2EventId)).find((e) => e.ref === ref);
    const effectiveStock =
      existing && existing.row.stock_limit !== undefined
        ? existing.row.stock_limit
        : capacity >= UNLIMITED_TIER_CAPACITY
          ? null
          : capacity;

    await saveCatalogEntry(
      v2EventId,
      toProductUpsert({
        ref,
        name,
        description,
        type: "ticket",
        price: 0,
        // stock_limit null = 무제한. comp 캡이 있으면 그 수치가 곧 발권 상한이다.
        stock: effectiveStock ?? null,
        minPerOrder: 1,
        maxPerOrder: null,
        taxIncluded: false,
        taxRate: 0,
        saleStartsAt: null,
        saleEndsAt: null,
        imageUrl: null,
        // 🔴 hidden — 공개 상품목록(visibility='public' 필터)에 절대 노출되지 않는다.
        visibility: "hidden",
        isActive: true,
        sortOrder: 0,
      }),
      // 결정적 멱등키 — 재시도·동시요청이 같은 tier 로 수렴한다.
      `free-product-tier:${ref}`,
    );
    return { productId: ref };
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) return null;
    throw err;
  }
}

export const RSVP_PRODUCT_NAME = "참석 등록";
export const COMP_PRODUCT_NAME = "초대권";

/** RSVP(무료 참석 self-registration) 전용 0원 상품. */
export function ensureRsvpProduct(pool: Pool | null, eventId: string, accountId: string) {
  return ensureFreeProduct(pool, eventId, accountId, RSVP_PRODUCT_NAME, "RSVP 무료 참석 등록");
}

/**
 * 주최자 수동발권·CSV 임포트·대량 초대(초대권/comp) 전용 0원 상품.
 * @param capacity F2 이벤트별 comp 캡(v2 tier capacity).
 */
export function ensureCompProduct(
  pool: Pool | null,
  eventId: string,
  accountId: string,
  capacity?: number,
) {
  return ensureFreeProduct(pool, eventId, accountId, COMP_PRODUCT_NAME, "초대권/수동발권 (0원)", capacity);
}
