/**
 * 🔴 라이브 표시 규칙 — 상태 넷과 홀 표기.
 *
 * ## 왜 이 파일이 중요한가
 * 관중은 이 화면을 보고 **실제로 걸어간다.** 멈춘 데이터를 실시간으로 표시하거나,
 * 없는 정밀도(「그린 도착」)를 지어내면 엉뚱한 홀로 간다.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_PHASE_LABEL,
  ageMinutes,
  formatHole,
  formatTotal,
  groupPhase,
  isLiveIndicatorOn,
  liveNotices,
} from "./presentation";

describe("🔴 U4 — 데이터가 멈추면 LIVE 표시를 끈다", () => {
  it("🔴 진행 중이면서 살아 있을 때만 켠다", () => {
    expect(isLiveIndicatorOn("live", false)).toBe(true);
    expect(isLiveIndicatorOn("live", true), "멈춘 데이터가 실시간으로 보인다").toBe(false);
    expect(isLiveIndicatorOn("not_started", false)).toBe(false);
    expect(isLiveIndicatorOn("ended", false)).toBe(false);
  });

  it("🔴 stale 안내에 기준 시각이 들어간다 — 언제 것인지 모르면 못 믿는다", () => {
    const n = liveNotices("live", true, 420).find((x) => x.tone === "warn");
    expect(n?.title).toBe("7분 전 기준");
  });

  it("⚠️ stale 이어도 값을 지우라고 하지 않는다 — 직전 값은 그대로 보여준다", () => {
    expect(liveNotices("live", true, 600)[0].body).toMatch(/마지막으로 받은/);
  });
});

/**
 * 🔴 U7 — **두 축은 직교한다.**
 *
 * 배포 세션 정정(2026-08-06): 넷을 한 축에 놓은 것이 틀렸다.
 * `status="live"` 이면서 `stale=true` 인 상태가 **정상적으로 존재한다** —
 * 경기는 하고 있는데 우리 쪽 데이터만 멈춘 경우다.
 *
 * ⚠️ 한 축으로 합치면 그 조합이 표현 불가능해지고, 화면은 「경기가 끝났다」거나
 *    「아직 시작 안 했다」고 **거짓말한다.**
 */
describe("🔴 U7 — status 와 stale 은 따로다", () => {
  it("🔴 live + stale 조합이 살아 있다 — 진행 중인데 데이터만 멈춘 상태", () => {
    const n = liveNotices("live", true, 600);
    // 진행 단계 안내는 없고(경기는 정상), 정지 경고만 뜬다.
    expect(n).toHaveLength(1);
    expect(n[0].tone).toBe("warn");
  });

  it("🔴 not_started + stale 이면 **둘 다** 뜬다", () => {
    const n = liveNotices("not_started", true, 600);
    expect(n.map((x) => x.tone)).toEqual(["info", "warn"]);
  });

  it("🔴 ended + stale 이면 **둘 다** 뜬다", () => {
    const n = liveNotices("ended", true, 600);
    expect(n).toHaveLength(2);
    expect(n[0].title).toMatch(/종료/);
  });

  it("live + 정상이면 아무 배너도 없다", () => {
    expect(liveNotices("live", false, 5)).toEqual([]);
  });
});

describe("🔴 U3 — not_started 를 반드시 만든다", () => {
  it("🔴 대회 전에는 내용 있는 대기 안내가 나온다 — 빈 목록은 고장으로 읽힌다", () => {
    // 게이트 오픈 06:00, 첫 조 출발 07:00. 그 한 시간이 가장 많이 열어보는 시각이다.
    const n = liveNotices("not_started", false, 0);
    expect(n, "not_started 갈래가 없다 — 첫날 아침이 빈 화면이 된다").toHaveLength(1);
    expect(n[0].title).toBe("곧 시작합니다");
    expect(n[0].body).toMatch(/첫 조가 출발하면/);
  });

  it("live 는 조용히 있는다 — 정상일 때 배너가 자리를 먹으면 안 된다", () => {
    expect(liveNotices("live", false, 10)).toEqual([]);
  });

  it("ended 는 종료를 알린다", () => {
    expect(liveNotices("ended", false, 0)[0].title).toMatch(/종료/);
  });
});

describe("데이터 나이", () => {
  it("1분 미만도 1분으로 — 0분 전은 멈춘 걸 안 멈춘 것처럼 보이게 한다", () => {
    expect(ageMinutes(30)).toBe(1);
    expect(ageMinutes(59)).toBe(1);
  });

  it("음수·비정상은 0", () => {
    expect(ageMinutes(-5)).toBe(0);
    expect(ageMinutes(Number.NaN)).toBe(0);
  });
});

describe("🔴 홀 표기 — 오차를 숨기지 않는다", () => {
  it("홀 번호로만 적는다", () => {
    expect(formatHole(15)).toBe("15번홀");
    expect(formatHole(15, true)).toBe("15번홀 부근");
  });

  it("모르면 대시 — 0 이나 없는 값을 1번홀로 만들지 않는다", () => {
    expect(formatHole(0)).toBe("-");
    expect(formatHole(null)).toBe("-");
    expect(formatHole(undefined)).toBe("-");
    expect(formatHole(Number.NaN)).toBe("-");
  });

  it("🔴 홀보다 작은 단위를 만들지 않는다 — 원천 오차가 ±1홀이다", () => {
    // 「그린 도착」·「페어웨이」·도보 시간·거리는 있지도 않은 정밀도다.
    const outputs = [formatHole(15), formatHole(15, true), formatHole(null)];
    for (const o of outputs) {
      expect(o).not.toMatch(/그린|페어웨이|티박스|이동 중|분|미터|m\b|도보/);
    }
  });
});

describe("총타수 표기", () => {
  it("언더·이븐·오버", () => {
    expect(formatTotal(-8)).toBe("-8");
    expect(formatTotal(0)).toBe("E");
    expect(formatTotal(3)).toBe("+3");
  });

  it("모르면 대시 — 0(이븐)과 구분된다", () => {
    expect(formatTotal(null)).toBe("-");
    expect(formatTotal(undefined)).toBe("-");
    expect(formatTotal(0)).toBe("E");
  });
});

describe("🔴 조 상태 — 안 나간 조를 코스 위로 세지 않는다", () => {
  it("현재 홀이 있으면 진행 중", () => {
    expect(groupPhase({ current_hole: 7, finished: false })).toBe("playing");
  });

  it("🔴 현재 홀이 0 이면 출발 대기다 — 코스 위로 세면 없는 조를 찾으러 간다", () => {
    expect(groupPhase({ current_hole: 0, finished: false })).toBe("waiting");
  });

  it("종료가 무엇보다 먼저다", () => {
    expect(groupPhase({ current_hole: 18, finished: true })).toBe("finished");
    expect(groupPhase({ current_hole: 0, finished: true })).toBe("finished");
  });

  it("라벨이 필터와 같은 값을 쓴다 — 화면이 두 갈래로 적지 않게", () => {
    expect(GROUP_PHASE_LABEL.playing).toBe("진행 중");
    expect(GROUP_PHASE_LABEL.waiting).toBe("출발 대기");
    expect(GROUP_PHASE_LABEL.finished).toBe("종료");
  });
});
