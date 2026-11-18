import { describe, expect, it } from "vitest";
import { localeFromPath } from "@/lib/locale-path";

describe("주소에서 언어 읽기", () => {
  it("기본 언어(ko)는 언어 칸이 없어 첫 칸을 언어로 읽지 않는다", () => {
    expect(localeFromPath("/orders/28b12995")).toBe("ko");
    expect(localeFromPath("/events/e1/booking")).toBe("ko");
    expect(localeFromPath("/")).toBe("ko");
    expect(localeFromPath(null)).toBe("ko");
  });
  it("언어 칸이 있으면 그 언어", () => {
    expect(localeFromPath("/en/orders/1")).toBe("en");
    expect(localeFromPath("/zh-CN/events/1")).toBe("zh-CN");
    expect(localeFromPath("/ko/orders/1")).toBe("ko");
  });
});
