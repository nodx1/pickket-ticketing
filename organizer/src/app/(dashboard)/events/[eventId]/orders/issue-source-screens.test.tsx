// @vitest-environment jsdom
/**
 * 🔴 목록과 상세가 **같은 문구**를 쓰는가 (2026-08-11).
 *
 * 판정을 두 화면에 복사하면 다음에 한쪽만 고쳐진다 — 오늘 `v2ErrorCode` 가 정확히
 * 그렇게 두 벌로 갈려 죽어 있었다. 그래서 **문구를 맞대어** 본다:
 * 같은 주문을 목록과 상세에 각각 넣고 **나온 문자열이 같은지**.
 *
 * ⚠️ 「배지가 있다」로는 부족하다. 한쪽이 「초대권」, 다른 쪽이 「초대권 (무료)」 여도
 *    둘 다 통과한다 — 발주처는 같은 주문을 두 이름으로 본다.
 */
import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchWithAuth = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/events/ev-1/orders",
}));
vi.mock("@/lib/fetchWithAuth", () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  fetchWithRefresh: vi.fn(),
}));
vi.mock("@/lib/hooks/useToast", () => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  useToast: () => ({ addToast: vi.fn() }),
}));

import { EventOrdersClient } from "./_components/event-orders-client";
import { ISSUE_SOURCE_LABEL, resolveIssueSource } from "@/lib/orders/issue-source";

type Flags = { isInvitation?: boolean | null; isManualIssue?: boolean | null };

function order(over: Flags & { id?: string; orderNumber?: string } = {}) {
  return {
    id: over.id ?? "o1",
    orderNumber: over.orderNumber ?? "ORD-260810-009",
    buyerName: "김구매",
    buyerEmail: "b@example.com",
    totalAmount: 27000,
    paidAmount: 27000,
    status: "completed",
    orderedAt: "2026-08-10T05:00:00Z",
    ...over,
  };
}

function mount(orders: Array<Record<string, unknown>>) {
  fetchWithAuth.mockResolvedValue({ success: true, data: orders, meta: { total: orders.length } });
  return render(<EventOrdersClient eventId="ev-1" />);
}

/** 주문번호 칸의 배지 문구(없으면 null). */
async function badgeText(orders: Array<Record<string, unknown>>): Promise<string | null> {
  mount(orders);
  await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
  const b = screen.queryByTestId("issue-source");
  return b ? (b.textContent ?? "").trim() : null;
}

/**
 * ⚠️ Radix Select 는 포인터 캡처·스크롤 API 를 쓴다. jsdom 에 없어서 목록이 안 열리고
 *    `role="option"` 을 못 찾는다 — **컴포넌트 결함이 아니라 환경 부족**이다.
 */
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => fetchWithAuth.mockReset());

describe("🔴 목록 배지", () => {
  it("🔴 초대권 주문에 배지가 뜬다", async () => {
    expect(await badgeText([order({ isInvitation: true })])).toBe("초대권 (무료)");
  });

  it("🔴 수동발권 주문", async () => {
    expect(await badgeText([order({ isManualIssue: true })])).toBe("주최자 수동발권");
  });

  it("🔴 카드 결제 주문에는 아무것도 안 뜬다", async () => {
    expect(
      await badgeText([order({ isInvitation: false, isManualIssue: false })]),
      "실판매에 배지가 붙었다 — 목록이 시끄러워진다",
    ).toBeNull();
  });

  it("🔴 v2 가 안 준 주문(undefined)에도 안 뜬다 — 모르면 안 붙인다", async () => {
    expect(await badgeText([order({})]), "모르는 주문에 배지가 붙었다").toBeNull();
  });

  it("🔴 주문마다 자기 배지 — 하나를 전부에 붙이면 안 된다", async () => {
    mount([
      order({ id: "o1", orderNumber: "ORD-A", isInvitation: true }),
      order({ id: "o2", orderNumber: "ORD-B" }),
    ]);
    await waitFor(() => expect(screen.getByText("ORD-B")).toBeInTheDocument());
    expect(screen.getAllByTestId("issue-source")).toHaveLength(1);
  });
});

/**
 * 🔴 W3 — 목록 문구가 상세와 갈리면 안 된다.
 *
 * 상세 화면은 서버 컴포넌트라 여기서 렌더하지 않는다. 대신 **둘 다 같은 공통 함수**에서
 * 문구를 가져오는지 본다 — 목록 배지 문자열이 `resolveIssueSource(...).label` 과
 * 정확히 같아야 한다. 한쪽이 문자열을 직접 적으면 여기서 갈린다.
 */
describe("🔴 W3 — 목록과 상세가 같은 출처에서 문구를 가져온다", () => {
  it("🔴 초대권 배지 = 공통 함수의 label", async () => {
    const t = await badgeText([order({ isInvitation: true })]);
    const src = resolveIssueSource({ isInvitation: true });
    expect(src.kind).not.toBe("sale");
    expect(t, "목록이 문구를 직접 적었다 — 상세와 갈린다").toBe(
      (src as { label: string }).label,
    );
  });

  it("🔴 수동발권 배지 = 공통 함수의 label", async () => {
    const t = await badgeText([order({ isManualIssue: true })]);
    expect(t).toBe(ISSUE_SOURCE_LABEL.manual);
  });

  it("배지는 주문번호와 같은 칸에 있다 — 눈으로 한 줄에서 읽힌다", async () => {
    mount([order({ isInvitation: true })]);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    const cell = screen.getByText("ORD-260810-009").closest("div");
    expect(within(cell as HTMLElement).getByTestId("issue-source")).toBeInTheDocument();
  });
});

/**
 * 🔴 발권 경로 필터 — **서버가 자르고, 화면은 안 잘렸으면 알린다** (2026-08-11).
 *
 * 실측 기준: 전체 84 = issued 51 + sale 33.
 *
 * ⚠️ 「셀렉트가 있다」로는 부족하다. **요청에 파라미터가 실렸는지**와
 *    **총계를 우리가 다시 세지 않는지**를 본다.
 */
function fetchCalls(): string[] {
  return fetchWithAuth.mock.calls.map((c) => String(c[0]));
}

function respond(rows: Array<Record<string, unknown>>, total: number, echo: string | null) {
  fetchWithAuth.mockResolvedValue({
    success: true,
    data: rows,
    meta: { total, issueSource: echo },
  });
}

describe("🔴 필터는 서버가 자른다", () => {
  it("🔴 고르면 요청에 issueSource 가 실린다", async () => {
    respond([order({ isInvitation: false })], 33, "sale");
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(fetchCalls().length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    await waitFor(() => expect(fetchCalls().some((u) => u.includes("issueSource=sale"))).toBe(true));
  });

  it("🔴 총계는 서버가 준 값을 쓴다 — 우리가 다시 세지 않는다", async () => {
    // ⚠️ 총계는 화면에 숫자로 안 나온다. **페이지 수**로만 드러난다(limit 20).
    //    서버 총계 33 → 2페이지. 클라이언트가 행을 셌다면(1건) 1페이지가 된다.
    respond([order({ isInvitation: false })], 33, "sale");
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "2" }),
      "총계를 화면이 다시 셌다 — 서버가 준 33이 아니라 행 수로 페이지를 만들었다",
    ).toBeInTheDocument();
  });
});

describe("🔴 이중 가드 — 서버가 안 잘랐으면 화면이 말한다", () => {
  it("🔴 에코가 안 오면 경고를 띄운다", async () => {
    // v2 가 파라미터를 무시한 상황(구버전·롤백·이름 변경).
    respond([order({ isInvitation: true })], 84, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    await waitFor(() =>
      expect(screen.getByTestId("filter-not-applied"), "필터가 안 먹었는데 조용하다").toBeInTheDocument(),
    );
  });

  it("🔴 경고가 「판매 실적으로 읽지 말라」고 명시한다", async () => {
    respond([order({ isInvitation: true })], 84, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    await waitFor(() =>
      expect(screen.getByTestId("filter-not-applied").textContent).toMatch(/판매 실적으로 읽지/),
    );
  });

  it("🔴 안 잘렸어도 목록을 감추지 않는다 — 배지로 구분은 유지된다", async () => {
    respond([order({ isInvitation: true })], 84, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    await waitFor(() => expect(screen.getByTestId("filter-not-applied")).toBeInTheDocument());
    expect(screen.getByTestId("issue-source").textContent).toBe("초대권 (무료)");
  });

  it("적용되면 경고가 없다", async () => {
    respond([order({ isInvitation: false })], 33, "sale");
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    await waitFor(() => expect(fetchCalls().some((u) => u.includes("issueSource=sale"))).toBe(true));
    expect(screen.queryByTestId("filter-not-applied")).toBeNull();
  });

  it("전체 보기에서는 경고가 없다 — 자를 게 없다", async () => {
    respond([order({ isInvitation: true })], 84, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    expect(screen.queryByTestId("filter-not-applied")).toBeNull();
  });
});

/**
 * 🔴 필터 묶음·라벨 (2026-08-11, 대표 지시).
 *
 * 「결제 완료 57건」이 실제로는 판매 6건이다. 두 축이 **다른 것을 거른다**는 게 안 읽히면
 * 발주처가 그 57을 매출로 읽는다. **정렬보다 라벨이 본질이다.**
 *
 * ⚠️ 「Label 이 있다」로는 부족하다 — 어느 칸의 라벨인지, 두 필터가 **한 묶음인지**를 본다.
 */
describe("🔴 필터 묶음과 라벨", () => {
  it("🔴 필터 둘이 한 부모 안에 있고, 검색은 그 밖에 있다", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());

    const group = screen.getByTestId("orders-filters");
    const inGroup = within(group).getAllByRole("combobox");
    expect(inGroup, "필터 둘이 한 묶음이 아니다 — 사이가 벌어져 중복으로 읽힌다").toHaveLength(2);
    // 검색은 묶음 밖 — 같이 들어가면 셋이 다시 흩어진다.
    const search = screen.getByPlaceholderText(/주문번호, 구매자, 이메일 검색/);
    expect(group.contains(search), "검색이 필터 묶음 안에 들어갔다").toBe(false);
  });

  it("🔴 각 칸이 무엇을 고르는지 열지 않고 읽힌다", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    const group = screen.getByTestId("orders-filters");
    expect(within(group).getByText("상태")).toBeInTheDocument();
    expect(within(group).getByText("발권 경로")).toBeInTheDocument();
  });

  it("🔴 라벨이 각자 자기 칸에 연결된다 — 클릭하면 그 칸으로 간다", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    // ⚠️ 「상태」는 표 헤더에도 있다 — 묶음 안으로 좁혀야 라벨을 집는다.
    const group = screen.getByTestId("orders-filters");
    expect(within(group).getByText("상태").getAttribute("for")).toBe("orders-status-filter");
    expect(within(group).getByText("발권 경로").getAttribute("for")).toBe("orders-source-filter");
    expect(document.getElementById("orders-status-filter")).not.toBeNull();
    expect(document.getElementById("orders-source-filter")).not.toBeNull();
  });

  it("🔴 aria-label 을 지우지 않았다 — 시각 라벨보다 구체적이다", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "주문 상태 필터" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "발권 경로 필터" })).toBeInTheDocument();
  });

  it("🔴 가드 배너는 필터 묶음 **다음에** 그대로 뜬다", async () => {
    respond([order({ isInvitation: true })], 84, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "실판매만" }));
    const banner = await screen.findByTestId("filter-not-applied");
    const group = screen.getByTestId("orders-filters");
    // 배너가 묶음 안으로 들어가면 필터 줄이 무너진다. 형제로 남아야 한다.
    expect(group.contains(banner)).toBe(false);
    expect(
      group.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
      "배너가 필터보다 위로 갔다",
    ).toBeTruthy();
  });
});

/**
 * 🔴 Z3 — **동작 불변**. 이번 변경은 정렬·표기뿐이고 쿼리·목록·총계는 그대로다.
 */
describe("🔴 Z3 — 정렬·표기만 바뀌고 동작은 그대로다", () => {
  it("🔴 상태를 바꾸면 status 쿼리가 그대로 나간다", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(fetchCalls().length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("combobox", { name: "주문 상태 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "결제 완료" }));
    await waitFor(() => expect(fetchCalls().some((u) => u.includes("status=completed"))).toBe(true));
  });

  it("🔴 발권 경로를 바꾸면 issueSource 쿼리가 그대로 나간다", async () => {
    respond([order()], 1, "issued");
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(fetchCalls().length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("combobox", { name: "발권 경로 필터" }));
    await userEvent.click(screen.getByRole("option", { name: "초대권·수동발권만" }));
    await waitFor(() => expect(fetchCalls().some((u) => u.includes("issueSource=issued"))).toBe(true));
  });

  it("🔴 총계는 여전히 서버 값을 쓴다", async () => {
    respond([order()], 33, "sale");
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });
});

/**
 * 🔴 배포 세션 뮤테이션에서 살아남은 자리 (2026-08-11).
 *
 * 묶임(`orders-filters` 안에 combobox 둘)은 단언돼 있었는데 **어디에 붙는가**는
 * 아무도 안 봤다. `lg:ml-auto` 를 빼도 27건이 전부 초록이었다 —
 * 대표가 지시한 「우측 정렬」이 그물 밖에 있었다.
 */
describe("🔴 필터 묶음이 오른쪽에 붙는다", () => {
  it("🔴 묶음이 남는 공간을 밀어내 우측으로 간다 (ml-auto)", async () => {
    respond([order()], 1, null);
    render(<EventOrdersClient eventId="ev-1" />);
    await waitFor(() => expect(screen.getByText("ORD-260810-009")).toBeInTheDocument());

    const group = screen.getByTestId("orders-filters");
    expect(
      group.className,
      "우측 정렬이 사라졌다 — 검색과 필터가 다시 양끝으로 흩어진다",
    ).toMatch(/\bml-auto\b/);
  });
});
