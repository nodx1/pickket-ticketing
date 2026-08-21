/**
 * 🔴 정가 취소선 판정 — **KLPGA 하나 보고 만들지 않는다.**
 *
 * 배정(2026-08-04): 온라인 10% 할인을 소구하려고 `~~₩15,000~~ ₩13,500` 을 그린다.
 *
 * ## 왜 판정을 함수로 뺐나
 * 상세 페이지와 체크아웃 1단계 **두 화면**이 같은 규칙을 써야 한다. 각자 조건을 적으면
 * 한쪽만 고쳐져 두 화면이 갈린다 — 오늘 초대권 화면에서 날짜 형식이 세 갈래로 갈렸다.
 *
 * ## 🔴 기본값은 "안 그린다"
 * 정가가 없거나 같은 다른 행사에서 `~~₩0~~` 이나 `~~₩13,500~~ ₩13,500` 이 뜨면
 * 할인 미표시보다 **더 큰 사고**다. 그래서 확실히 할인일 때만 그린다.
 */
import { describe, expect, it } from "vitest";
import { strikethroughPrice } from "./face-price";

describe("그린다 — 실제로 할인인 경우만", () => {
  it("정가가 판매가보다 높으면 정가를 돌려준다", () => {
    expect(strikethroughPrice(13500, 15000)).toBe(15000);
    expect(strikethroughPrice(22500, 25000)).toBe(25000);
  });

  it("문자열 금액도 읽는다 — v2 가 문자열로 줄 때가 있다", () => {
    expect(strikethroughPrice("13500", "15000")).toBe(15000);
  });
});

describe("🔴 안 그린다 — 이쪽이 기본값이다", () => {
  it("정가가 없으면(미시딩) 안 그린다", () => {
    expect(strikethroughPrice(13500, null)).toBeNull();
    expect(strikethroughPrice(13500, undefined)).toBeNull();
  });

  it("🔴 정가와 판매가가 같으면 안 그린다 — 할인이 아니다", () => {
    expect(strikethroughPrice(15000, 15000), "~~₩15,000~~ ₩15,000 이 뜬다").toBeNull();
  });

  it("🔴 정가가 0 이면 안 그린다 — ~~₩0~~ 방지", () => {
    expect(strikethroughPrice(13500, 0)).toBeNull();
    expect(strikethroughPrice(13500, -100)).toBeNull();
  });

  it("정가가 판매가보다 낮으면 안 그린다 — 데이터 이상", () => {
    expect(strikethroughPrice(15000, 13500)).toBeNull();
  });

  it("무료 티켓(판매가 0)에 정가가 있으면 그린다 — 초대권이 아니라 할인이다", () => {
    // ⚠️ 0원 판매 + 정가 15,000 은 "전액 할인" 이다. 데이터로는 정상이므로 그린다.
    //    초대권(comp)은 애초에 이 목록에 안 뜬다(`selectPublicTiers` 가 거른다).
    expect(strikethroughPrice(0, 15000)).toBe(15000);
  });

  it("판매가를 못 읽으면 안 그린다", () => {
    expect(strikethroughPrice(null, 15000)).toBeNull();
    expect(strikethroughPrice("말이 안 되는 값", 15000)).toBeNull();
    expect(strikethroughPrice(13500, "말이 안 되는 값")).toBeNull();
  });

  it("빈 문자열은 값이 아니다", () => {
    expect(strikethroughPrice("", 15000)).toBeNull();
    expect(strikethroughPrice(13500, "")).toBeNull();
  });
});
