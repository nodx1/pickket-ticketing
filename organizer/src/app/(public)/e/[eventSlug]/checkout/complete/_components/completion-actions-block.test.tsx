// @vitest-environment jsdom
/**
 * 🔴 완료 화면 행동 블록 — **무엇이 복사되고, 어떤 순서로 놓이는가**.
 *
 * ⚠️ 「복사 버튼이 있다」로는 아무것도 증명되지 않는다. 손님이 은행 앱에 붙여넣는
 *    값이 무엇인지가 전부다 — 은행명·예금주가 섞여 들어가면 손님이 지워야 한다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompletionActionsBlock } from "./completion-actions-block";
import { CopyAccountButton } from "./copy-account-button";

const BASE = {
  bankAccount: "140-016-400872",
  eventHref: "/e/klpga",
  eventTitle: "BC카드·한경 제48회 KLPGA 챔피언십",
  eventSlug: "klpga",
  startsAt: "2026-08-20T01:00:00Z",
  endsAt: "2026-08-23T01:00:00Z",
  venueName: "포천힐스CC",
  venueAddress: "경기 포천시",
};

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

describe("🔴 복사 버튼 — 클립보드에 들어가는 값", () => {
  it("🔴 계좌번호만 복사한다 — 은행명·예금주를 섞지 않는다", async () => {
    render(<CopyAccountButton account="140-016-400872" label="입금 계좌 복사" />);
    await userEvent.click(screen.getByRole("button", { name: "입금 계좌 복사" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("140-016-400872");
  });

  it("복사하면 눌린 것을 알린다", async () => {
    render(<CopyAccountButton account="140-016-400872" label="입금 계좌 복사" />);
    await userEvent.click(screen.getByRole("button", { name: "입금 계좌 복사" }));
    expect(await screen.findByText("복사했습니다")).toBeInTheDocument();
  });

  it("🔴 클립보드가 막히면 삼키지 않고 알린다 — 손으로 옮겨 적을 수 있어야 한다", async () => {
    writeText.mockRejectedValue(new Error("blocked"));
    render(<CopyAccountButton account="140-016-400872" label="입금 계좌 복사" />);
    await userEvent.click(screen.getByRole("button", { name: "입금 계좌 복사" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/직접 입력/);
  });

  it("여러 번 눌러도 같은 값이 나간다", async () => {
    render(<CopyAccountButton account="140-016-400872" label="입금 계좌 복사" />);
    const b = screen.getByRole("button");
    await userEvent.click(b);
    await userEvent.click(b);
    expect(new Set(writeText.mock.calls.map((c) => c[0]))).toEqual(new Set(["140-016-400872"]));
  });
});

describe("🔴 층이 갈려 있다 — 한 줄에 몰아넣지 않는다", () => {
  it("🔴 주 행동·보조·캘린더가 각자 자기 줄을 가진다", () => {
    render(
      <CompletionActionsBlock
        {...BASE}
        cta={{ kind: "copy-account", label: "입금 계좌 복사" }}
      />,
    );
    // 세 층이 모두 존재하고, 서로를 품지 않는다(형제여야 한다).
    const primary = screen.getByTestId("completion-primary");
    const secondary = screen.getByTestId("completion-secondary");
    const calendar = screen.getByTestId("completion-calendar");
    expect(primary.contains(secondary), "보조가 주 행동 줄 안에 있다").toBe(false);
    expect(primary.contains(calendar), "캘린더가 주 행동 줄 안에 있다").toBe(false);
    expect(secondary.contains(calendar), "🔴 캘린더가 보조 버튼과 같은 줄에 있다").toBe(false);
  });

  it("🔴 캘린더 블록이 보조 줄에 섞이지 않는다 — 그게 정렬이 깨진 원인이었다", () => {
    render(<CompletionActionsBlock {...BASE} cta={{ kind: "copy-account", label: "입금 계좌 복사" }} />);
    const secondary = screen.getByTestId("completion-secondary");
    expect(within(secondary).queryByText("캘린더에 추가"), "캘린더가 보조 줄에 들어갔다").toBeNull();
    expect(within(screen.getByTestId("completion-calendar")).getByText("캘린더에 추가")).toBeInTheDocument();
  });

  it("보조 줄에는 버튼 둘만 있다", () => {
    render(<CompletionActionsBlock {...BASE} cta={{ kind: "copy-account", label: "입금 계좌 복사" }} />);
    const links = within(screen.getByTestId("completion-secondary")).getAllByRole("link");
    expect(links.map((a) => a.textContent?.trim())).toEqual(["길찾기", "행사 페이지로"]);
  });

  it("행사 경로를 모르면 그 버튼을 안 그린다 — /e/undefined 로 보내지 않는다", () => {
    render(
      <CompletionActionsBlock {...BASE} eventHref={null} cta={{ kind: "copy-account", label: "입금 계좌 복사" }} />,
    );
    const links = within(screen.getByTestId("completion-secondary")).getAllByRole("link");
    expect(links.map((a) => a.textContent?.trim())).toEqual(["길찾기"]);
  });
});

describe("주 행동이 상태를 따라간다", () => {
  it("입금 대기 — 복사 버튼", () => {
    render(<CompletionActionsBlock {...BASE} cta={{ kind: "copy-account", label: "입금 계좌 복사" }} />);
    const p = screen.getByTestId("completion-primary");
    expect(within(p).getByRole("button", { name: "입금 계좌 복사" })).toBeInTheDocument();
    expect(within(p).queryByText("티켓 확인하기"), "입금 대기인데 티켓 링크가 있다").toBeNull();
  });

  it("결제 완료 — 티켓 링크", () => {
    render(
      <CompletionActionsBlock
        {...BASE}
        cta={{ kind: "ticket", label: "티켓 확인하기", href: "/tickets/PK-9" }}
      />,
    );
    const a = within(screen.getByTestId("completion-primary")).getByRole("link");
    expect(a).toHaveAttribute("href", "/tickets/PK-9");
  });

  it("🔴 계좌를 모르면 복사 버튼을 그리지 않는다 — 빈 값을 복사시키면 안 된다", () => {
    render(
      <CompletionActionsBlock
        {...BASE}
        bankAccount={null}
        cta={{ kind: "copy-account", label: "입금 계좌 복사" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "입금 계좌 복사" })).toBeNull();
    // 대신 링크로 떨어진다(막다른 곳을 만들지 않는다).
    expect(within(screen.getByTestId("completion-primary")).getByRole("link")).toBeInTheDocument();
  });
});

/**
 * 🔴 배포 세션 독립 뮤테이션에서 살아남은 두 자리 (2026-08-10).
 *
 * 판정(primaryCta)과 동작(CopyAccountButton)은 각각 못박혀 있었는데,
 * **블록이 그 둘을 실제로 잇는지**는 아무도 안 봤다. 복사 버튼을 평범한 버튼으로
 * 바꿔도 101건이 전부 초록이었다 — 오늘 v2ErrorCode 가 두 벌로 갈려 죽어 있던 것과 같은 결이다.
 */
describe("🔴 블록이 판정과 동작을 실제로 잇는다", () => {
  it("🔴 copy-account 면 **정말 클립보드에 계좌가 들어간다** — 버튼 모양만으로는 부족하다", async () => {
    render(
      <CompletionActionsBlock {...BASE} cta={{ kind: "copy-account", label: "입금 계좌 복사" }} />,
    );
    await userEvent.click(
      within(screen.getByTestId("completion-primary")).getByRole("button", { name: "입금 계좌 복사" }),
    );
    expect(writeText, "블록이 복사 버튼을 안 쓰고 있다").toHaveBeenCalledWith("140-016-400872");
  });

  it("🔴 판정이 준 문구를 그대로 쓴다 — 화면에 문구를 박아두지 않는다", () => {
    render(
      <CompletionActionsBlock
        {...BASE}
        cta={{ kind: "orders", label: "예약 내역 확인", href: "/my-tickets" }}
      />,
    );
    const primary = screen.getByTestId("completion-primary");
    expect(within(primary).getByText("예약 내역 확인")).toBeInTheDocument();
    expect(within(primary).queryByText("티켓 확인하기"), "화면이 문구를 박아뒀다").toBeNull();
  });
});
