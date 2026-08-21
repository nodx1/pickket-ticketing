/**
 * VenueMap — **빈 탭 방지** 회귀.
 *
 * 🔴 2026-07-28: 종전엔 주소가 없으면 `return null` 로 전체를 숨겼다. 그래서 주소를 안 넣고
 *    주차·교통만 입력한 이벤트는 그 안내가 통째로 안 보였다.
 *    탭 구조(`event-tabs.ts::hasVenueTab`)는 **주차/교통만 있어도 탭을 연다**. 두 판정이
 *    어긋나면 "탭은 열리는데 안이 빈" 상태가 된다 — 우리가 금지한 바로 그 상태다.
 *
 * ⟹ 이 파일은 **탭 판정과 렌더 조건이 같은 전제를 쓰는지** 지킨다.
 *    `hasVenueTab` 을 바꾸면 여기가 깨져야 한다.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VenueMap } from "./venue-map";
import { hasVenueTab } from "@/lib/public/event-tabs";

vi.mock("@/lib/hooks/useToast", () => ({ showSuccess: vi.fn() }));

function render(props: Parameters<typeof VenueMap>[0]) {
  return renderToStaticMarkup(createElement(VenueMap, props));
}

describe("VenueMap — 주소 없이도 안내를 렌더한다", () => {
  it("주차 안내만 있어도 렌더한다 (탭이 열리는 조건과 일치)", () => {
    const props = {
      venueName: "골프장",
      venueAddress: null,
      transportInfo: null,
      parkingInfo: "제1주차장 이용, 셔틀 10분 간격",
    };
    // 탭 판정이 이 조합에 대해 탭을 연다면,
    expect(hasVenueTab({ parkingInfo: props.parkingInfo })).toBe(true);
    // 렌더도 반드시 내용이 있어야 한다(빈 탭 금지).
    const html = render(props);
    expect(html).toContain("주차 안내");
    expect(html).toContain("제1주차장");
  });

  it("대중교통 안내만 있어도 렌더한다", () => {
    const html = render({
      venueName: null,
      venueAddress: null,
      transportInfo: "OO역 3번 출구 셔틀",
      parkingInfo: null,
    });
    expect(html).toContain("대중교통 안내");
    expect(html).toContain("셔틀");
  });

  it("주소가 없으면 복사·지도 버튼은 그리지 않는다 (빈 검색어 방지)", () => {
    const html = render({
      venueName: "골프장",
      venueAddress: null,
      transportInfo: null,
      parkingInfo: "주차 가능",
    });
    expect(html).not.toContain("주소 복사");
    expect(html).not.toContain("map.naver.com");
  });

  it("주소가 있으면 종전대로 주소·복사·지도를 모두 그린다", () => {
    const html = render({
      venueName: "골프장",
      venueAddress: "경기도 어딘가 1-1",
      transportInfo: null,
      parkingInfo: null,
    });
    expect(html).toContain("경기도 어딘가 1-1");
    expect(html).toContain("주소 복사");
    expect(html).toContain("map.naver.com");
  });

  it("셋 다 없으면 아무것도 그리지 않는다 (탭도 안 열린다)", () => {
    expect(hasVenueTab({})).toBe(false);
    expect(render({ venueName: "골프장", venueAddress: null, transportInfo: null, parkingInfo: null })).toBe("");
  });
});
