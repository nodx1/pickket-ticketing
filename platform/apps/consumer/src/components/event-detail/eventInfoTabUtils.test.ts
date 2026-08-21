import { describe, expect, it } from "vitest";
import { formatPeriod } from "./eventInfoTabUtils";

/**
 * 레벨2 컷오버(W2-EVT) 회귀.
 *
 * 옛 go 경로는 단일일 이벤트에 `event_date_end: null` 을 보냈다. 그런데 go `events.ends_at`
 * 은 NOT NULL 이라, 그 상태로 go DB 를 삭제하면 **단일일 이벤트의 종료 일시가 비가역 소실**된다.
 * 그래서 이제 종료일시를 **항상** 전파한다.
 *
 * 그 대가로 "존재하면 기간 표시" 로직이 단일일 이벤트에 `8.1 ~ 8.1 (1일간)` 을 띄우게 됐다.
 * 스키마를 새로 파는 대신 **표시 조건**을 바로잡았고, 이 테스트가 그 조건을 고정한다.
 */
describe("formatPeriod — 단일일 이벤트에 기간 표기를 만들지 않는다", () => {
  it("시작·종료가 같은 날이면 빈 문자열(호출측이 기간 블록을 통째로 숨긴다)", () => {
    // KST 기준 같은 날, 시각만 다름 (10:00 ~ 18:00)
    expect(
      formatPeriod("2026-08-01T01:00:00Z", "2026-08-01T09:00:00Z"),
    ).toBe("");
  });

  it("KST 기준 같은 날이면 UTC 날짜가 갈려도 빈 문자열", () => {
    // UTC 로는 7/31 과 8/1 이지만 KST 로는 둘 다 8/1 (한국 밤 시간대 이벤트)
    expect(
      formatPeriod("2026-07-31T12:00:00Z", "2026-07-31T14:00:00Z"),
    ).toBe("");
  });

  it("실제 여러 날이면 기존대로 기간을 표기한다", () => {
    expect(formatPeriod("2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z")).toBe(
      "8.1 ~ 8.5 (4일간)",
    );
  });

  it("해가 바뀌어도 같은 월·일을 같은 날로 오판하지 않는다", () => {
    const r = formatPeriod("2026-12-31T00:00:00Z", "2027-12-31T00:00:00Z");
    expect(r).not.toBe("");
    expect(r).toContain("~");
  });

  it("한쪽이 없으면 빈 문자열(기존 계약 유지)", () => {
    expect(formatPeriod(undefined, "2026-08-05T00:00:00Z")).toBe("");
    expect(formatPeriod("2026-08-01T00:00:00Z", undefined)).toBe("");
  });
});
