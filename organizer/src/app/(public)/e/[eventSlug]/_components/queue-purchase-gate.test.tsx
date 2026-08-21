// @vitest-environment jsdom
/**
 * 🔴 구매 진입점 — **렌더해서** 확인한다 (2026-08-02, 렌더 테스트 도입 첫 건).
 *
 * ## 왜 이 컴포넌트가 첫 대상인가
 * 2026-08-01 에 여기서 「페이지는 되는데 못 사는」 상태가 났다. 구매 버튼이
 * `POST .../queue/join` 성공에 묶여 있어서, v2 가 한 번 흔들리면
 * **"구매 대기열 확인 중..." 인 채 영구히 잠겼다**(재시도 수단도 없었다).
 *
 * 그때는 렌더 테스트를 **못 썼다** — `@testing-library/react` 가 없고 vitest 가
 * `.tsx` 를 수집조차 안 했다. 그래서 순수 판정 함수 + 파일 문자열 가드로 우회했고,
 * 실제 화면 동작은 **prod 크롤**로만 확인했다.
 *
 * ⟹ 도구가 생겼으니 **그 결함을 렌더로 재현·고정한다.** 도구 도입의 값어치를
 *    "설치했다" 가 아니라 **"이 결함을 잡는다"** 로 증명한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueuePurchaseGate } from "./queue-purchase-gate";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const BASE = { eventId: "ev-1", eventSlug: "klpga-2026", soldOut: false, label: "티켓 구매하기" };

describe("대기열을 쓰지 않는 행사", () => {
  it("🔴 대기열 요청을 아예 보내지 않는다 — 실패할 요청이 없어야 한다", async () => {
    render(<QueuePurchaseGate {...BASE} queueEnabled={false} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "티켓 구매하기" })).toBeInTheDocument());
    const queueCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/queue/"));
    expect(queueCalls, "안 쓰는 기능 때문에 결제가 잠기던 왕복").toEqual([]);
  });

  it("🔴 버튼이 처음부터 체크아웃으로 열려 있다 — **누를 수 있는 상태로**", () => {
    render(<QueuePurchaseGate {...BASE} queueEnabled={false} />);
    const link = screen.getByRole("link", { name: "티켓 구매하기" });
    expect(link).toHaveAttribute("href", "/e/klpga-2026/checkout");

    // ⚠️ 링크가 **그려지는 것만으로는 부족하다.** `disabled` 가 실려 있으면
    //    보이기만 하고 안 눌린다 — 손님에겐 "안 되는 버튼" 이다.
    //    (실측: 이 단언이 없을 때 `disabled` 를 항상 켜는 뮤테이션이 생존했다.)
    expect(link).not.toHaveAttribute("disabled");
    expect(link).not.toHaveAttribute("aria-disabled", "true");
    // ⚠️ className 으로는 못 본다 — `disabled:pointer-events-none` 은 **Tailwind 변형**이라
    //    항상 붙어 있다(활성 상태가 아니다). 실제로 그걸로 검사했다가 오탐이 났다.
  });

  it("매진이면 대기열과 무관하게 잠긴다", () => {
    render(<QueuePurchaseGate {...BASE} soldOut queueEnabled={false} />);
    expect(screen.getByText("매진되었습니다")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("대기열을 쓰는 행사 — 게이트는 살아 있다", () => {
  it("🔴 입장 전에는 잠겨 있고 요청을 보낸다", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // 응답 보류
    render(<QueuePurchaseGate {...BASE} queueEnabled />);
    expect(screen.getByText("구매 대기열 확인 중...")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/queue/join"))).toBe(true),
    );
  });

  it("입장(active)하면 버튼이 열린다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { sessionToken: "s".repeat(20), position: 0, status: "active", estimatedWait: 0, accessToken: "a".repeat(20) },
      }),
    });
    render(<QueuePurchaseGate {...BASE} queueEnabled />);
    await waitFor(() => expect(screen.getByRole("link", { name: "티켓 구매하기" })).toBeInTheDocument());
  });
});

/**
 * 🔴 2026-08-01 결함의 **정확한 재현**: 참여가 실패했을 때 손님이 할 수 있는 게 있는가.
 */
describe("참여 실패 — 막다른 상태가 되지 않는다", () => {
  it("🔴 다시 시도 버튼이 나오고, 누르면 재요청한다", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new Error("network"));
    render(<QueuePurchaseGate {...BASE} queueEnabled />);

    const retry = await screen.findByRole("button", { name: /다시 시도/ });
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes("/queue/join")).length;
    expect(before).toBeGreaterThan(0);

    await user.click(retry);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u).includes("/queue/join")).length,
        "다시 시도를 눌러도 재요청이 없다 — 버튼이 장식이다",
      ).toBeGreaterThan(before),
    );
  });

  it("실패 문구가 다음 행동을 알려준다", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    render(<QueuePurchaseGate {...BASE} queueEnabled />);
    const msg = await screen.findByText(/대기열 참여에 실패/);
    expect(msg.textContent, "실패만 알리고 무엇을 하면 되는지 안 알려준다").toMatch(/다시 시도/);
  });
});
