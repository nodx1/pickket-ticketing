import { describe, it, expect } from "vitest";

import {
  MAX_EVENT_TAGS,
  hasProgramTab,
  hasVenueTab,
  hasText,
  normalizeEventTagsInput,
  parseEventTags,
  resolveEventTabs,
  type PublicEventTabInput,
} from "./event-tabs";

/** 아무 탭 조건도 만족하지 않는 최소 입력(= intro/contact 만 남는 상태). */
const EMPTY: PublicEventTabInput = {
  description: null,
  summary: null,
  scheduleCount: 0,
  programNotes: null,
  isOnline: false,
  venueAddress: null,
  transportInfo: null,
  parkingInfo: null,
  stageInfo: null,
};

const ids = (input: PublicEventTabInput) => resolveEventTabs(input).map((t) => t.id);

describe("hasText", () => {
  it("공백만 있는 문자열은 '없음'으로 본다", () => {
    expect(hasText("   ")).toBe(false);
    expect(hasText("\n\t")).toBe(false);
    expect(hasText("")).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
    expect(hasText("주차 가능")).toBe(true);
  });
});

describe("hasProgramTab", () => {
  it("일정도 프로그램 안내도 없으면 false", () => {
    expect(hasProgramTab(EMPTY)).toBe(false);
  });

  it("이벤트 일정이 1건이라도 있으면 true", () => {
    expect(hasProgramTab({ ...EMPTY, scheduleCount: 1 })).toBe(true);
  });

  it("프로그램 안내 문구만 있어도 true", () => {
    expect(hasProgramTab({ ...EMPTY, programNotes: "1라운드 09:00 티오프" })).toBe(true);
  });

  it("프로그램 안내가 공백뿐이면 false (빈 탭 방지)", () => {
    expect(hasProgramTab({ ...EMPTY, programNotes: "   \n " })).toBe(false);
  });

  it("scheduleCount 미지정(undefined)은 0으로 본다", () => {
    expect(hasProgramTab({ programNotes: null })).toBe(false);
  });
});

describe("hasVenueTab", () => {
  it("주소·교통·주차·무대안내가 전부 없으면 false", () => {
    expect(hasVenueTab(EMPTY)).toBe(false);
  });

  it("주차 안내만 있어도 true (대표 요구 — 주차가 묻히지 않게)", () => {
    expect(hasVenueTab({ ...EMPTY, parkingInfo: "제1주차장 200면" })).toBe(true);
  });

  it("주소/대중교통/주차 각각 단독으로 true", () => {
    expect(hasVenueTab({ ...EMPTY, venueAddress: "경기도 여주시" })).toBe(true);
    expect(hasVenueTab({ ...EMPTY, transportInfo: "셔틀버스 운행" })).toBe(true);
    expect(hasVenueTab({ ...EMPTY, parkingInfo: "제1주차장" })).toBe(true);
  });

  /**
   * 🔴 2026-07-28 자체검수 회귀 — **렌더 블록이 없는 조건으로 탭을 열지 않는다.**
   * 종전엔 아래 둘로도 탭이 열렸는데 패널에 대응 렌더가 **없어서 빈 탭**이 됐다.
   * 필드를 배선하고 렌더 블록을 넣을 때 조건도 **함께** 살려야 한다 — 반대 순서는 빈 탭을 만든다.
   */
  it("온라인 이벤트만으로는 열지 않는다 — 온라인 안내 렌더 블록이 없다", () => {
    expect(hasVenueTab({ ...EMPTY, isOnline: true })).toBe(false);
  });

  it("stageInfo 만으로는 열지 않는다 — 무대안내 렌더 블록이 없다", () => {
    expect(hasVenueTab({ ...EMPTY, stageInfo: "18번 홀 그린 스탠드" })).toBe(false);
  });

  it("showVenueMap=false 면 내용이 있어도 무조건 false (주최자가 숨긴 것)", () => {
    expect(
      hasVenueTab({ ...EMPTY, parkingInfo: "제1주차장", showVenueMap: false }),
    ).toBe(false);
    expect(hasVenueTab({ ...EMPTY, isOnline: true, showVenueMap: false })).toBe(false);
  });

  it("showVenueMap 미지정(undefined)은 노출로 본다 (기존 `!== false` 동작 보존)", () => {
    expect(hasVenueTab({ parkingInfo: "제1주차장" })).toBe(true);
  });

  it("장소명은 판정 입력이 아니다 — 장소명만으로는 탭을 열지 않는다", () => {
    // venueName 이 PublicEventTabInput 에 없다는 계약을 고정('행사 소개' 정보 카드가 담당).
    expect(hasVenueTab({ ...EMPTY, venueAddress: "" })).toBe(false);
    expect(Object.keys(EMPTY)).not.toContain("venueName");
  });
});

describe("resolveEventTabs", () => {
  it("내용이 하나도 없으면 intro·contact 2개만", () => {
    expect(ids(EMPTY)).toEqual(["intro", "contact"]);
  });

  it("일정·주차가 있으면 4개 전부, 순서 고정", () => {
    expect(ids({ ...EMPTY, scheduleCount: 3, parkingInfo: "제1주차장" })).toEqual([
      "intro",
      "program",
      "venue",
      "contact",
    ]);
  });

  it("프로그램만 있으면 venue 는 빠진다", () => {
    expect(ids({ ...EMPTY, programNotes: "1부 · 2부" })).toEqual([
      "intro",
      "program",
      "contact",
    ]);
  });

  it("장소만 있으면 program 은 빠진다", () => {
    expect(ids({ ...EMPTY, venueAddress: "서울시 송파구" })).toEqual([
      "intro",
      "venue",
      "contact",
    ]);
  });

  it("모든 탭에 한국어 라벨이 붙는다", () => {
    const tabs = resolveEventTabs({ ...EMPTY, scheduleCount: 1, parkingInfo: "P1" });
    expect(tabs.map((t) => t.label)).toEqual([
      "행사 소개",
      "프로그램",
      "장소·주차",
      "문의",
    ]);
  });

  it("탭 id 는 중복되지 않는다(Radix value 충돌 방지)", () => {
    const list = ids({ ...EMPTY, scheduleCount: 1, programNotes: "x", parkingInfo: "P1", venueAddress: "A" });
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("parseEventTags", () => {
  it("JSON 배열 문자열을 파싱한다(v2 events.tags 표현)", () => {
    expect(parseEventTags('["가족","야외"]')).toEqual(["가족", "야외"]);
  });

  it("쉼표 구분 문자열도 흡수한다", () => {
    expect(parseEventTags("가족, 야외 , ")).toEqual(["가족", "야외"]);
  });

  it("'#' 접두를 제거하고 중복을 제거한다", () => {
    expect(parseEventTags('["#골프","골프","#골프"]')).toEqual(["골프"]);
  });

  it("빈 값·비배열 JSON 은 빈 배열", () => {
    expect(parseEventTags(null)).toEqual([]);
    expect(parseEventTags("")).toEqual([]);
    expect(parseEventTags("   ")).toEqual([]);
    expect(parseEventTags("[]")).toEqual([]);
    expect(parseEventTags('{"a":1}')).toEqual([]);
  });

  it("문자열이 아닌 요소는 버린다", () => {
    expect(parseEventTags('["가족",3,null,"야외"]')).toEqual(["가족", "야외"]);
  });

  it("개수 상한을 넘기지 않는다", () => {
    const many = Array.from({ length: MAX_EVENT_TAGS + 7 }, (_, i) => `태그${i}`);
    expect(parseEventTags(JSON.stringify(many))).toHaveLength(MAX_EVENT_TAGS);
  });

  it("태그 길이를 20자로 자른다", () => {
    const long = "가".repeat(40);
    expect(parseEventTags(JSON.stringify([long]))[0]).toHaveLength(20);
  });
});

describe("normalizeEventTagsInput", () => {
  it("주최자 쉼표 입력을 정리한다", () => {
    expect(normalizeEventTagsInput(" #KLPGA, 골프 ,, 골프 ")).toEqual(["KLPGA", "골프"]);
  });

  it("빈 입력은 빈 배열(태그 삭제 의도)", () => {
    expect(normalizeEventTagsInput("")).toEqual([]);
    expect(normalizeEventTagsInput("  ,  , ")).toEqual([]);
    expect(normalizeEventTagsInput(null)).toEqual([]);
  });

  it("파싱 → 직렬화 → 재파싱 왕복이 안정적이다", () => {
    const normalized = normalizeEventTagsInput("가족, 야외, 가족");
    expect(parseEventTags(JSON.stringify(normalized))).toEqual(normalized);
  });
});
