import { describe, expect, it } from "vitest";

import { formatKstDateTime, toIsoFromKstLocal, toKstLocalInput } from "./kst-local";

/**
 * 🔴 여기가 틀어지면 **주최자가 넣은 시각과 손님이 보는 시각이 달라진다**
 * (2026-07-31 실사고 — `07:00~18:00` 입력이 `16:00~다음날 03:00` 으로 표시됐다).
 *
 * 이 파일은 **결정적**이어야 한다. `new Date(naive)` 는 실행 환경 시간대에 따라 답이 달라지는데,
 * 그게 정확히 이번 사고의 원인이었다 — 개발 PC(KST)에서는 맞고 서버(UTC)에서는 틀렸다.
 * 그래서 아래 단언에 **환경 의존이 없어야** 한다.
 */
describe("toIsoFromKstLocal", () => {
  it("🔴 시간대 없는 입력을 KST 로 해석한다 — 실사고 값 그대로", () => {
    // 주최자가 넣은 "2026-08-20 07:00" 은 한국시각 → UTC 로는 전날 22:00
    expect(toIsoFromKstLocal("2026-08-20T07:00")).toBe("2026-08-19T22:00:00.000Z");
    expect(toIsoFromKstLocal("2026-08-20T18:00")).toBe("2026-08-20T09:00:00.000Z");
  });

  it("자정 근처에서 날짜가 하루 당겨진다", () => {
    expect(toIsoFromKstLocal("2026-08-20T00:00")).toBe("2026-08-19T15:00:00.000Z");
    expect(toIsoFromKstLocal("2026-08-20T08:59")).toBe("2026-08-19T23:59:00.000Z");
    expect(toIsoFromKstLocal("2026-08-20T09:00")).toBe("2026-08-20T00:00:00.000Z");
  });

  it("초가 붙어도 처리한다", () => {
    expect(toIsoFromKstLocal("2026-08-20T07:00:30")).toBe("2026-08-19T22:00:30.000Z");
  });

  /**
   * 🔴 이게 없으면 **두 번 밀린다.** 이미 저장된 값(`Z`)이나 v2 응답을 다시 넣었을 때
   * 또 -9 를 하면 기존 데이터가 매 저장마다 9시간씩 과거로 간다.
   */
  it("시간대가 붙은 값은 이미 확정된 시각이므로 건드리지 않는다", () => {
    expect(toIsoFromKstLocal("2026-08-19T22:00:00.000Z")).toBe("2026-08-19T22:00:00.000Z");
    expect(toIsoFromKstLocal("2026-08-20T07:00:00+09:00")).toBe("2026-08-19T22:00:00.000Z");
  });

  it.each([null, undefined, "", "   ", "말도 안 되는 값"])("못 읽는 값(%o)은 null", (v) => {
    expect(toIsoFromKstLocal(v as string)).toBeNull();
  });
});

describe("toKstLocalInput", () => {
  it("🔴 저장된 UTC 를 입력칸용 한국시각으로 되돌린다 — 없으면 수정할 때마다 밀린다", () => {
    expect(toKstLocalInput("2026-08-19T22:00:00.000Z")).toBe("2026-08-20T07:00");
    expect(toKstLocalInput("2026-08-20T09:00:00.000Z")).toBe("2026-08-20T18:00");
  });

  it("왕복이 손실 없다 — 넣고 → 꺼내고 → 다시 넣어도 같다", () => {
    const local = "2026-08-20T07:00";
    const iso = toIsoFromKstLocal(local)!;
    expect(toKstLocalInput(iso)).toBe(local);
    expect(toIsoFromKstLocal(toKstLocalInput(iso))).toBe(iso);
  });

  it.each([null, undefined, "", "깨진값"])("못 읽는 값(%o)은 빈 문자열", (v) => {
    expect(toKstLocalInput(v as string)).toBe("");
  });
});

describe("formatKstDateTime", () => {
  /**
   * 🔴 `timeZone` 을 안 박으면 **보는 사람 PC 시간대**로 렌더된다.
   * 해외 스태프에게 같은 일정이 다른 시각으로 보인다.
   */
  it("보는 환경과 무관하게 한국시각으로 렌더한다", () => {
    const out = formatKstDateTime("2026-08-19T22:00:00.000Z");
    expect(out).toContain("2026");
    expect(out).toContain("08");
    expect(out).toContain("20"); // KST 기준 20일 (UTC 로는 19일)
    expect(out).toMatch(/07:00|오전 07:00/);
  });

  it.each([null, undefined, "", "깨진값"])("못 읽는 값(%o)은 '-'", (v) => {
    expect(formatKstDateTime(v as string)).toBe("-");
  });
});
