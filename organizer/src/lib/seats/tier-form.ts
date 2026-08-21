/**
 * 등급 입력 폼 → API 페이로드 변환·검증 (순수 로직).
 *
 * ## 왜 컴포넌트에서 분리했나
 * 종전 `tier-manager.tsx` 는 생성 페이로드에 **`capacity: 0` 을 하드코딩**하고 있었다.
 * 수량 입력란 자체가 없어 화면에서 만든 등급은 전부 재고 0 → 즉시 매진이었고,
 * 그 사실을 잡아낼 테스트가 없었다(컴포넌트 안에 박혀 있어 테스트가 닿지 못함).
 * 판정 로직을 순수 함수로 빼서 회귀 테스트가 직접 호출하도록 한다.
 *
 * ## capacity 0 을 금지하지 않는 이유
 * 지정석 워크플로는 **등급을 먼저 만들고 배치도를 그려 좌석 수를 채우는** 순서가 정상이다
 * (`seat-tiers/route.ts` 주석 참조). 0 을 막으면 그 흐름이 깨진다.
 * 대신 0 은 **판매 불가 상태**임을 화면이 명시적으로 경고한다(`isUnsellableCapacity`).
 */

/** v2 `seat-tiers` POST/PATCH 스키마 상한과 동일해야 한다. */
export const TIER_CAPACITY_MAX = 100_000;

export interface TierFormInput {
  name: string;
  /** 원 단위 문자열. 빈 값은 미입력. */
  price: string;
  /** 장 단위 문자열. **빈 값 = 0**(배치도로 채우는 지정석 흐름). */
  capacity: string;
  colorHex: string;
}

export interface TierPayload {
  name: string;
  basePrice: number;
  capacity: number;
  colorHex: string;
}

export type TierFormResult =
  | { ok: true; payload: TierPayload }
  | { ok: false; error: string };

/** 정수 문자열만 통과. `"12.5"` `"1e3"` `"12a"` 는 거부한다. */
function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 수량 0 = 판매 불가(공개 페이지에서 매진으로 표시된다). */
export function isUnsellableCapacity(capacity: number): boolean {
  return capacity <= 0;
}

export function buildTierPayload(input: TierFormInput): TierFormResult {
  const name = input.name.trim();
  if (name === "") {
    return { ok: false, error: "등급 이름을 입력해주세요" };
  }

  const basePrice = parseIntStrict(input.price);
  if (basePrice === null) {
    return { ok: false, error: "가격을 숫자로 입력해주세요" };
  }

  // 빈 값은 0 — 배치도에서 좌석을 그려 채우는 지정석 흐름을 막지 않는다.
  const capacity = input.capacity.trim() === "" ? 0 : parseIntStrict(input.capacity);
  if (capacity === null) {
    return { ok: false, error: "수량을 숫자로 입력해주세요" };
  }
  if (capacity > TIER_CAPACITY_MAX) {
    return {
      ok: false,
      error: `수량은 ${TIER_CAPACITY_MAX.toLocaleString()}장을 넘을 수 없습니다`,
    };
  }

  return { ok: true, payload: { name, basePrice, capacity, colorHex: input.colorHex } };
}

/** 인라인 수정 대상 — 화면에서 고칠 수 있는 필드만. */
export interface TierEditable {
  name: string;
  basePrice: number;
  capacity: number;
}

export type TierPatchResult =
  | { ok: true; patch: Partial<TierEditable> }
  | { ok: false; error: string };

/**
 * 변경된 필드만 담은 PATCH 본문을 만든다.
 *
 * 🔴 **전체 필드를 항상 보내지 않는 이유**: 서버 PATCH 는 받은 필드만 갱신하지만,
 * 손대지 않은 값을 되돌려 보내면 그 사이 다른 경로(배치도 저장 등)가 바꾼 값을
 * 낡은 값으로 덮어쓴다. 변경분만 보내 그 창을 없앤다.
 *
 * 변경이 없으면 `patch` 는 빈 객체이고, 호출부는 요청을 보내지 않는다.
 */
export function buildTierPatch(
  current: TierEditable,
  edited: { name: string; price: string; capacity: string },
): TierPatchResult {
  const built = buildTierPayload({
    name: edited.name,
    price: edited.price,
    capacity: edited.capacity,
    colorHex: "#000000", // 인라인 수정 대상 아님 — 검증만 재사용한다
  });
  if (!built.ok) return built;

  const patch: Partial<TierEditable> = {};
  if (built.payload.name !== current.name) patch.name = built.payload.name;
  if (built.payload.basePrice !== current.basePrice) patch.basePrice = built.payload.basePrice;
  if (built.payload.capacity !== current.capacity) patch.capacity = built.payload.capacity;

  return { ok: true, patch };
}
