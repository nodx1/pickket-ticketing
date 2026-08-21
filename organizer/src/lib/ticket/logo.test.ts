import { describe, expect, it } from "vitest";
import { resolveTicketLogoUrl } from "./logo";

describe("티켓 로고 URL 해석 — 폴백 ① 키 없음", () => {
  it("정본 키(logoUrl)가 있으면 그것을 쓴다", () => {
    expect(resolveTicketLogoUrl({ logoUrl: "https://cdn/a.png" })).toBe("https://cdn/a.png");
  });

  it("🔴 정본 키가 없고 레거시 키(logoImageUrl)만 있으면 레거시를 쓴다", () => {
    // 이 폴백이 없으면 옛 디자이너로 저장한 주최자의 로고가 **통일하는 순간 전부 사라진다**.
    expect(resolveTicketLogoUrl({ logoImageUrl: "https://cdn/legacy.png" })).toBe(
      "https://cdn/legacy.png",
    );
  });

  it("둘 다 있으면 정본이 이긴다", () => {
    expect(
      resolveTicketLogoUrl({ logoUrl: "https://cdn/new.png", logoImageUrl: "https://cdn/old.png" }),
    ).toBe("https://cdn/new.png");
  });

  it("빈 문자열·공백은 '없음' 으로 본다 (src=\"\" 는 현재 페이지를 재요청한다)", () => {
    expect(resolveTicketLogoUrl({ logoUrl: "", logoImageUrl: "  " })).toBeNull();
    expect(resolveTicketLogoUrl({ logoUrl: "   ", logoImageUrl: "https://cdn/x.png" })).toBe(
      "https://cdn/x.png",
    );
  });

  it("null·undefined 입력에도 죽지 않는다", () => {
    expect(resolveTicketLogoUrl(null)).toBeNull();
    expect(resolveTicketLogoUrl(undefined)).toBeNull();
    expect(resolveTicketLogoUrl({})).toBeNull();
    expect(resolveTicketLogoUrl({ logoUrl: null, logoImageUrl: null })).toBeNull();
  });

  it("앞뒤 공백은 다듬는다", () => {
    expect(resolveTicketLogoUrl({ logoUrl: "  https://cdn/a.png  " })).toBe("https://cdn/a.png");
  });
});

describe("폴백 ② 파일 404 는 여기서 처리하지 않는다", () => {
  it("URL 문자열만으로는 404 를 알 수 없다 — 그대로 돌려준다", () => {
    // 이 경로는 렌더 시점 `onError` 의 몫이다(`logo.ts` 주석 ②).
    // 여기서 "존재하는 URL 인지" 판정하려 들면 서버 왕복이 생기고, 그래도 렌더 순간의
    // 404 는 못 막는다. 두 경로를 뭉치지 않는다는 것을 이 검사로 고정한다.
    expect(resolveTicketLogoUrl({ logoUrl: "https://cdn/does-not-exist.png" })).toBe(
      "https://cdn/does-not-exist.png",
    );
  });
});
