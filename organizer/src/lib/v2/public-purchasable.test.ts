import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findNonPurchasable, isPubliclyPurchasable } from "./public-purchasable";

type Tier = Parameters<typeof isPubliclyPurchasable>[0];
const tier = (visibility?: string | null, is_active?: boolean | null): Tier =>
  ({ visibility, is_active }) as Tier;

/**
 * 🔴 **초대권 발급은 대시보드에서만** (2026-08-01 대표 지시, 티켓 오픈 당일).
 *
 * ## 무슨 상태였나
 * 티어에는 `visibility` 가 있고 `hidden`/`private` 는 주최자 전용이다
 * (초대권 = 0원, 정원 1,000,000). 그런데 두 곳이 다른 규칙을 썼다:
 *
 *     공개 상세 화면   `isPubliclyVisibleTier()` 로 숨김 티어를 뺀다      ✅
 *     공개 구매 처리   `tierMap.has(id)` — 이 행사 티어인가만 본다        ❌
 *
 * ⟹ **메뉴판에선 빠지는데 주문은 받아준다.** 티어 ID 를 아는 사람이 직접 호출하면
 *    0원 주문이 성립하고, 발권된 티켓은 정상 초대권과 구분되지 않는다
 *    (게이트는 등급 가격을 보지 않는다 — 볼 이유도 없다).
 *
 * prod 실측(오픈 시점): 초대권 발급 0장 · 부정 생성 흔적 0건. 뚫리기 전에 막는다.
 */
describe("isPubliclyPurchasable", () => {
  it("공개 티어는 판다", () => {
    expect(isPubliclyPurchasable(tier("public")).ok).toBe(true);
  });

  it("🔴 숨김·비공개 티어는 공개 경로에서 팔지 않는다", () => {
    expect(isPubliclyPurchasable(tier("hidden")).ok).toBe(false);
    expect(isPubliclyPurchasable(tier("private")).ok).toBe(false);
  });

  it("판매 중단(is_active=false)은 어느 경로로도 팔지 않는다", () => {
    expect(isPubliclyPurchasable(tier("public", false)).ok).toBe(false);
  });

  it("대소문자·공백이 섞여 와도 막는다", () => {
    expect(isPubliclyPurchasable(tier(" HIDDEN ")).ok).toBe(false);
  });

  /**
   * ⚠️ 여기만 fail-**open** 이다. 다른 상태 게이트(티켓 사용가능 등)는 미지값을 막지만,
   *    이 자리는 반대다 — `visibility` 가 없는 응답(구버전 v2·필드 누락)에서 전부 거절하면
   *    **정상 판매가 통째로 멈춘다.** 오픈 당일 판매 중단이 훨씬 큰 사고다.
   *    막아야 하는 건 **명시적으로 숨김인 티어**뿐이다.
   */
  it("🔴 visibility 를 모르면 판다 — 여기서 fail-closed 하면 판매가 멈춘다", () => {
    expect(isPubliclyPurchasable(tier(undefined)).ok).toBe(true);
    expect(isPubliclyPurchasable(tier(null)).ok).toBe(true);
    expect(isPubliclyPurchasable(tier("")).ok).toBe(true);
  });

  it("모르는 visibility 값은 판다 — 화이트리스트가 아니라 블랙리스트다", () => {
    expect(isPubliclyPurchasable(tier("unlisted_future_value")).ok).toBe(true);
  });
});

describe("findNonPurchasable — 요청 목록 전수", () => {
  const map = new Map<string, Tier>([
    ["p-public", tier("public")],
    ["p-hidden", tier("hidden")],
    ["p-inactive", tier("public", false)],
  ]);

  it("전부 공개면 null", () => {
    expect(findNonPurchasable(map, ["p-public"])).toBeNull();
  });

  it("🔴 하나라도 숨김이면 그걸 집어낸다 — 섞어 보내는 게 전형적 수법이다", () => {
    expect(findNonPurchasable(map, ["p-public", "p-hidden"])).toEqual({
      productId: "p-hidden",
      reason: "hidden",
    });
  });

  it("모르는 상품도 잡는다", () => {
    expect(findNonPurchasable(map, ["p-nope"])?.reason).toBe("unknown_tier");
  });

  it("판매 중단도 잡는다", () => {
    expect(findNonPurchasable(map, ["p-inactive"])?.reason).toBe("inactive");
  });

  it("빈 목록은 통과 — 수량 검증은 다른 관문의 일이다", () => {
    expect(findNonPurchasable(map, [])).toBeNull();
  });
});

/**
 * 🔴 관문이 **공개 경로에만** 걸렸는지, 그리고 **대시보드 발급을 막지 않는지**를 고정한다.
 *
 * 주최자가 초대권을 발급하는 것은 정상 동작이다. 여기까지 막으면 초대권 기능이 통째로 죽는다.
 */
const APP = path.join(process.cwd(), "src/app/api");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("관문 배치", () => {
  it("🔴 공개 구매(checkout/initiate)에 걸려 있다", () => {
    const code = stripComments(readFileSync(path.join(APP, "checkout/initiate/route.ts"), "utf8"));
    expect(code).toMatch(/findNonPurchasable\(tierMap, itemIds\)/);
    // 금액 합산보다 **먼저** 막아야 한다 — 0원 상품이 합계에 섞이면 통과한다.
    expect(code.indexOf("findNonPurchasable")).toBeLessThan(code.indexOf("const serverTotal"));
  });

  it("🔴 공개 대기열 신청에도 걸려 있다 — 같은 계열이다", () => {
    const code = stripComments(readFileSync(path.join(APP, "events/[eventId]/waitlist/route.ts"), "utf8"));
    expect(code).toMatch(/isPubliclyVisibleTier\(entryForProduct\.row\)/);
  });

  it("🔴 대시보드 초대권 발급은 막지 않는다 — 막으면 기능이 죽는다", () => {
    const code = stripComments(
      readFileSync(path.join(process.cwd(), "src/lib/server/invitations.ts"), "utf8"),
    );
    expect(
      code,
      "주최자의 초대권 발급은 정상 동작이다. 이 관문을 여기 붙이면 안 된다.",
    ).not.toMatch(/findNonPurchasable|isPubliclyPurchasable/);
  });

  it("공개 RSVP 는 서버가 만든 전용 상품을 쓴다 — 사용자가 티어를 못 고른다", () => {
    const code = stripComments(
      readFileSync(path.join(APP, "events/[eventId]/public/rsvp/route.ts"), "utf8"),
    );
    // 사용자 입력 productId 를 그대로 쓰면 같은 구멍이 생긴다.
    expect(code).toMatch(/ensureRsvpProduct/);
    expect(code).toMatch(/productId: rsvpProduct\.productId/);
  });
});
