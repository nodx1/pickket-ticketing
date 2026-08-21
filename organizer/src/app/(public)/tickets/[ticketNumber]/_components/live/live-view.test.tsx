// @vitest-environment jsdom
/**
 * 🔴 라이브 화면 — **어떤 state 에서 무엇이 나오는가**.
 *
 * ⚠️ 「LIVE 가 DOM 에 있다」로는 아무것도 증명되지 않는다. 상태 넷을 각각 넣고
 *    ① 초록 점이 켜지는지 ② 어떤 안내가 나오는지 ③ 값이 지워지지 않는지를 본다.
 *
 * 🔴 그리고 **티켓 탭은 어떤 경우에도 살아 있어야 한다.** 라이브가 못 떠서 티켓까지
 *    못 보면 그게 사고다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const feed = vi.fn();
vi.mock("@/lib/live/use-live-summary", () => ({
  useLiveSummary: () => feed(),
  LIVE_POLL_MS: 20_000,
}));

import { LiveView } from "./live-view";
import type { LiveStatus, LiveSummary } from "@/lib/live/types";

function summary(over: Partial<LiveSummary> & { status: LiveStatus }): LiveSummary {
  return {
    stale: false,
    game_code: "2026080004",
    // 🔴 기본은 **관중에게 안전함이 확인된** 상태. 리허설 테스트만 이 값을 바꾼다.
    is_rehearsal: false,
    tournament: { name: "BC카드·한경 제48회 KLPGA 챔피언십", round: 2 },
    leaders: [{ rank: 1, tied: false, player_code: "p1", name: "박선수", total: -8, current_hole: 15 }],
    groups: [
      { group_no: 3, tee_time: "06:50", start_hole: 10, current_hole: 7, finished: false, players: [{ player_code: "g박선수", name: "박선수", total: -8, current_hole: 1 }] },
      { group_no: 9, tee_time: "08:10", start_hole: 1, current_hole: 0, finished: false, players: [{ player_code: "g김선수", name: "김선수", total: 0, current_hole: 1 }] },
    ],
    content_age_sec: 30,
    updated_at: "2026-08-20T10:42:00+09:00",
    ...over,
  };
}

/**
 * 🔴 2026-08-20 — 기본 탭이 「티켓」으로 바뀌었다(게이트에서 QR 이 먼저여야 한다).
 *    라이브 내용을 보는 테스트는 **홈 탭을 명시적으로 연다**.
 */
function openHome() {
  openTab("홈");
}

function openTab(label: string) {
  const t = screen.getAllByRole("tab").find((x) => x.textContent?.includes(label));
  if (t) fireEvent.click(t);
}

function mount(status: LiveStatus | null, over: Partial<LiveSummary> = {}, failing = false) {
  feed.mockReturnValue({
    summary: status === null ? null : summary({ status, ...over }),
    loading: false,
    failing,
    lastOkAt: status === null ? null : Date.now(),
  });
  const r = render(
    <LiveView
      ticketNumber="PK-1"
      eventTitle="폴백 대회명"
      ticketPanel={<div data-testid="ticket-panel">티켓 내용</div>}
      schedules={[]}
    />,
  );
  openHome();
  return r;
}

beforeEach(() => feed.mockReset());

describe("🔴 U4 — 데이터가 멈추면 실시간 표시를 끈다", () => {
  it("live 면 LIVE 점이 켜진다", () => {
    mount("live");
    expect(screen.getByTestId("live-indicator")).toBeInTheDocument();
  });

  it("🔴 멈췄으면 LIVE 점이 없다 — 멈춘 데이터를 실시간으로 보여주면 안 된다", () => {
    mount("live", { stale: true, content_age_sec: 600 });
    expect(screen.queryByTestId("live-indicator"), "멈췄는데 LIVE 가 떠 있다").toBeNull();
  });

  it("🔴 멈춰도 값을 지우지 않는다 — 직전 순위·조가 그대로 보인다", async () => {
    mount("live", { stale: true, content_age_sec: 600 });
    await userEvent.click(screen.getByRole("tab", { name: "리더보드" }));
    expect(screen.getByText("박선수")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "조편성" }));
    expect(screen.getByText("3조")).toBeInTheDocument();
  });

  it("기준 시각을 밝힌다", () => {
    mount("live", { stale: true, content_age_sec: 600 });
    expect(screen.getByTestId("live-notice-warn").textContent).toContain("10분 전 기준");
  });

  it("not_started·ended 도 LIVE 가 아니다", () => {
    mount("not_started");
    expect(screen.queryByTestId("live-indicator")).toBeNull();
    mount("ended");
    expect(screen.queryByTestId("live-indicator")).toBeNull();
  });
});

describe("🔴 U3 — 대회 전 빈 화면 금지", () => {
  it("🔴 not_started 면 내용 있는 대기 안내가 뜬다", () => {
    mount("not_started", { groups: [], leaders: [], tournament: { name: null, round: 0 } });
    const n = screen.getByTestId("live-notice-info");
    expect(n.textContent).toContain("곧 시작합니다");
    expect(n.textContent).toContain("첫 조가 출발하면");
  });

  it("대회명이 없으면 우리 행사명으로 폴백한다 — 제목이 비면 고장으로 읽힌다", () => {
    mount("not_started", { tournament: { name: null, round: 0 } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("폴백 대회명");
  });

  it("live 면 배너가 없다", () => {
    mount("live");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("🔴 티켓 탭은 어떤 경우에도 살아 있다", () => {
  it("정상일 때 열린다", async () => {
    mount("live");
    await userEvent.click(screen.getByRole("tab", { name: "티켓" }));
    expect(screen.getByTestId("ticket-panel")).toBeInTheDocument();
  });

  it("🔴 라이브를 하나도 못 받아도 티켓은 열린다", async () => {
    mount(null);
    expect(screen.getByText(/준비하고 있습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "티켓" }));
    expect(screen.getByTestId("ticket-panel"), "라이브가 죽자 티켓까지 사라졌다").toBeInTheDocument();
  });
});

// 🔴 2026-08-20 현장: 기본 탭이 「홈」이라 재입장 손님이 QR 을 못 찾았다.
//    티켓을 맨 앞·기본으로 옮겼다. 이 순서가 계약이다.
describe("탭 다섯", () => {
  // 🔴 2026-08-20 현장: 기본 탭이 「홈」이라 재입장 손님이 QR 을 못 찾았다.
  //    티켓을 **맨 앞·기본**으로 옮겼다. 이 순서가 계약이다.
  it("티켓·홈·리더보드·조편성·이벤트", () => {
    mount("live");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "티켓",
      "홈",
      "리더보드",
      "조편성",
      "이벤트",
    ]);
  });

  it("🔴 조편성에 출발 홀이 함께 나온다 — 같은 시각에 두 조가 나간다", async () => {
    mount("live");
    await userEvent.click(screen.getByRole("tab", { name: "조편성" }));
    // 3조는 10번홀 출발. 조 번호만으로는 현장에서 못 찾는다.
    expect(screen.getByText("10번홀 출발")).toBeInTheDocument();
  });

  it("갱신 실패 시 값은 두고 사실만 알린다", async () => {
    mount("live", {}, true);
    expect(screen.getByText(/마지막으로 받은 값/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "리더보드" }));
    expect(screen.getByText("박선수"), "실패했다고 값을 지웠다").toBeInTheDocument();
  });
});

/**
 * 🔴 U6 — **리허설 데이터는 관중에게 한 조각도 안 나간다** (2026-08-06 델타).
 *
 * 8/6~8/19 에는 **다른 대회의 실제 스코어**가 온다. BC카드 티켓에 제주삼다수 순위가
 * 뜨면 빈 화면보다 나쁘다 — 손님은 고장이 아니라 **엉뚱한 대회를 판다**고 읽는다.
 *
 * ⚠️ 「LiveView 가 안 뜬다」로는 부족하다. **선수 이름·조·순위가 DOM 에 하나도 없어야** 한다.
 */
describe("🔴 U6 — 리허설 차단", () => {
  it("🔴 is_rehearsal 이면 선수·조·순위가 화면에 없다", async () => {
    mount("live", { is_rehearsal: true });
    expect(screen.queryByText("박선수"), "리허설 선수 이름이 관중에게 보인다").toBeNull();
    expect(screen.queryByText("김선수")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "조편성" }));
    expect(screen.queryByText("3조"), "리허설 조편성이 관중에게 보인다").toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "리더보드" }));
    expect(screen.queryByText("박선수")).toBeNull();
  });

  it("🔴 리허설이면 LIVE 점도 끈다", () => {
    mount("live", { is_rehearsal: true });
    expect(screen.queryByTestId("live-indicator")).toBeNull();
  });

  it("🔴 리허설 대회명이 제목으로 새지 않는다 — 우리 행사명으로 폴백", () => {
    mount("live", { is_rehearsal: true, tournament: { name: "제주삼다수 마스터스", round: 1 } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("폴백 대회명");
    expect(document.body.textContent).not.toContain("제주삼다수");
  });

  it("🔴 필드가 없으면(구버전) 막는다 — fail-closed", () => {
    mount("live", { is_rehearsal: undefined });
    expect(screen.queryByText("박선수"), "확인 안 된 데이터가 관중에게 나갔다").toBeNull();
  });

  it("⚠️ 관중에게 '리허설' 이라고 밝히지 않는다 — 발주처 화면이다", () => {
    mount("live", { is_rehearsal: true });
    expect(document.body.textContent).not.toMatch(/리허설|테스트|rehearsal/i);
  });

  it("🔴 리허설이어도 티켓 탭은 열린다", async () => {
    mount("live", { is_rehearsal: true });
    await userEvent.click(screen.getByRole("tab", { name: "티켓" }));
    expect(screen.getByTestId("ticket-panel")).toBeInTheDocument();
  });

  it("🔴 URL 파라미터로 우회할 수 없다 — 링크 한 번 새면 끝이다", () => {
    window.history.replaceState({}, "", "/tickets/PK-1?rehearsal=1&preview=1&debug=1");
    mount("live", { is_rehearsal: true });
    expect(screen.queryByText("박선수"), "쿼리로 리허설이 뚫렸다").toBeNull();
    window.history.replaceState({}, "", "/");
  });
});

/**
 * 🔴 F3·F4 — **하단 고정 탭바**.
 *
 * 승인 샘플이 하단 탭바였다. 한 손으로 든 폰에서 엄지가 닿는 곳이고, 골프장에서는
 * **서서 보는** 화면이라 상단 탭은 반대쪽 손을 쓰게 만든다.
 *
 * ⚠️ **jsdom 은 레이아웃을 계산하지 않는다.** 여기서는 구조(위치 지정·안전영역 여백)만
 *    고정하고, **실제로 화면 아래에 붙어 있는지는 프로덕션 빌드 + 브라우저**로 잰다
 *    (bounding box 측정 — 보고서에 수치를 남긴다).
 */
describe("🔴 F3·F4 — 하단 고정 탭바", () => {
  it("🔴 탭바가 화면 하단에 고정된다", () => {
    mount("live");
    const bar = screen.getByTestId("live-tabbar");
    expect(bar.className, "상단 세그먼트로 되돌아갔다").toContain("fixed");
    expect(bar.className).toContain("bottom-0");
    expect(bar.className).toContain("inset-x-0");
  });

  it("🔴 안전영역을 반영한다 — 아이폰 홈 인디케이터에 겹치면 마지막 탭이 안 눌린다", () => {
    mount("live");
    // ⚠️ jsdom 은 bare `env()` 를 CSSOM 에서 거부한다(값이 빈 문자열). 그래서 **클래스**로 본다.
    //    🔴 클래스가 있다 ≠ CSS 가 생성됐다 — 실제 여백은 브라우저 측정으로 따로 확인한다.
    expect(screen.getByTestId("live-tabbar").className, "safe-area 여백이 없다").toContain(
      "env(safe-area-inset-bottom)",
    );
  });

  it("🔴 본문이 탭바에 가리지 않도록 하단 여백을 잡는다", () => {
    const { container } = mount("live");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className, "본문 여백이 없다 — 마지막 항목이 탭바에 가린다").toContain(
      "env(safe-area-inset-bottom)",
    );
  });

  it("탭 5개가 아이콘과 라벨을 함께 가진다", () => {
    mount("live");
    const bar = screen.getByTestId("live-tabbar");
    const tabs = within(bar).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["티켓", "홈", "리더보드", "조편성", "이벤트"]);
    for (const t of tabs) {
      expect(t.querySelector("svg"), `${t.textContent} 아이콘이 없다`).not.toBeNull();
    }
  });

  it("🔴 티켓 탭이 그 바 안에 있다 — 안내 문구가 「아래 티켓」이라고 말한다", async () => {
    mount("live");
    const bar = screen.getByTestId("live-tabbar");
    await userEvent.click(within(bar).getByRole("tab", { name: "티켓" }));
    expect(screen.getByTestId("ticket-panel")).toBeInTheDocument();
  });
});
