// @vitest-environment node
/**
 * 🔴 완료 화면이 **판정을 실제로 쓰는가** — 페이지 단위 (2026-08-08).
 *
 * `completion-actions.test.ts` 는 **판정**을 지킨다. 하지만 화면이 그 함수를 안 부르고
 * 옛 JSX 를 그대로 두면 무통장 손님은 여전히 「티켓 확인하기」를 본다.
 * 그래서 서버 컴포넌트를 직접 호출해 **나온 트리에 무엇이 있는지**를 본다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getPublicOrderCompletion = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/qrCode", () => ({ generateQRDataURL: async () => "data:image/png;base64,QR" }));
vi.mock("@/lib/server/events", () => ({
  getPublicOrderCompletion: (...a: unknown[]) => getPublicOrderCompletion(...a),
}));
vi.mock("@/lib/checkout/offline-payment", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bankInfoFromEnv: () => ({
    ok: true as const,
    info: { bankName: "신한은행", account: "140-016-400872", holder: "(주)노드엑스" },
  }),
}));

import CompletePage from "./page";

function order(over: Record<string, unknown> = {}) {
  return {
    orderNumber: "ORD-260810-009",
    status: "pending",
    paymentMethod: "bank_transfer",
    totalAmount: 27000,
    ticketNumber: null,
    eventTitle: "BC카드·한경 제48회 KLPGA 챔피언십",
    startsAt: "2026-08-20T01:00:00Z",
    endsAt: "2026-08-23T01:00:00Z",
    venueName: "포천힐스CC",
    venueAddress: "경기 포천시",
    ...over,
  };
}

/**
 * 🔴 블록을 컴포넌트로 뺐으므로(2026-08-08) 페이지가 검증할 것은 **넘기는 props** 다.
 *    내부 마크업은 `_components/completion-actions-block.test.tsx` 가 본다.
 */
export function findProps(node: unknown, name: string): Record<string, unknown> | null {
  const seen = new Set<object>();
  let hit: Record<string, unknown> | null = null;
  const walk = (n: unknown) => {
    if (hit || !n || typeof n !== "object" || seen.has(n as object)) return;
    seen.add(n as object);
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { type?: { name?: string }; props?: Record<string, unknown> };
    if (typeof el.type === "function" && el.type.name === name) { hit = el.props ?? {}; return; }
    Object.values(el.props ?? {}).forEach(walk);
  };
  walk(node);
  return hit;
}

/** 트리를 훑어 텍스트·컴포넌트 이름을 모은다. */
function collect(node: unknown, out: { names: string[]; text: string[] } = { names: [], text: [] }) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, out));
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const t = el.type;
  if (typeof t === "function") out.names.push((t as { name?: string }).name ?? "anon");
  for (const [k, v] of Object.entries(el.props ?? {})) {
    if (k === "children") collect(v, out);
    else if (typeof v === "string") out.text.push(v);
  }
  return out;
}

async function render(over: Record<string, unknown> = {}) {
  getPublicOrderCompletion.mockResolvedValue(order(over));
  const tree = await CompletePage({
    params: Promise.resolve({ eventSlug: "bc-hankyung-klpga2026" }),
    searchParams: Promise.resolve({ orderId: "ord-1" }),
  } as never);
  return { ...collect(tree), tree };
}

beforeEach(() => vi.clearAllMocks());

describe("🔴 무통장 입금 대기", () => {
  it("🔴 주 버튼이 「입금 계좌 복사」다 — 「티켓 확인하기」가 아니다", async () => {
    const r = await render();
    const props = findProps(r.tree, "CompletionActionsBlock");
    expect(props, "행동 블록이 안 붙었다").not.toBeNull();
    expect(props!.cta).toEqual({ kind: "copy-account", label: "입금 계좌 복사" });
  });

  it("🔴 안내가 없는 QR 을 제시하라고 하지 않는다", async () => {
    const r = await render();
    const all = r.text.join(" ");
    expect(all).toContain("입금이 확인되면 모바일 티켓이 발급됩니다");
    expect(all, "발급 전인데 QR 제시를 안내한다").not.toContain("QR 코드를 스태프에게 제시");
  });

  it("복사 대상은 계좌번호다 — 은행명·예금주를 섞지 않는다", async () => {
    const r = await render();
    expect(findProps(r.tree, "CompletionActionsBlock")!.bankAccount).toBe("140-016-400872");
  });

  it("(옛 형태 보존) 트리 순회가 중복을 세지 않는다", async () => {
    getPublicOrderCompletion.mockResolvedValue(order());
    const tree = await CompletePage({
      params: Promise.resolve({ eventSlug: "x" }),
      searchParams: Promise.resolve({ orderId: "o" }),
    } as never);
    // ⚠️ 같은 노드를 두 번 밟지 않는다 — children 을 두 경로로 훑으면 값이 중복돼
    //    "복사 버튼이 여러 개" 로 오독한다(첫 시도에서 8개로 나왔다).
    const seen = new Set<object>();
    const found = new Set<string>();
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object" || seen.has(n as object)) return;
      seen.add(n as object);
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const el = n as { type?: { name?: string }; props?: Record<string, unknown> };
      if (typeof el.type === "function" && el.type.name === "CopyAccountButton") {
        found.add(String(el.props?.account));
      }
      Object.values(el.props ?? {}).forEach(walk);
    };
    walk(tree);
    expect([...found]).toEqual([]);  // 블록으로 뺐으므로 페이지 트리엔 직접 없다
  });
});

describe("결제 완료(카드)", () => {
  it("티켓이 있으면 「티켓 확인하기」", async () => {
    const r = await render({ status: "completed", paymentMethod: "card", ticketNumber: "PK-9" });
    const props = findProps(r.tree, "CompletionActionsBlock")!;
    expect(props.cta).toEqual({ kind: "ticket", label: "티켓 확인하기", href: "/tickets/PK-9" });
  });

  it("종전 당일 안내가 그대로 나온다", async () => {
    const r = await render({ status: "completed", paymentMethod: "card", ticketNumber: "PK-9" });
    expect(r.text.join(" ")).toContain("QR 코드를 스태프에게 제시");
  });
});

describe("🔴 버튼 층이 갈려 있다 — 한 줄에 몰아넣지 않는다", () => {
  it("캘린더 블록이 주 버튼과 같은 줄에 있지 않다", async () => {
    // `CalendarLinks` 는 라벨+칩 3개의 2단 블록이라 한 줄 flex 에 넣으면 줄이 깨진다.
    const r = await render({ status: "completed", paymentMethod: "card", ticketNumber: "PK-9" });
    // 층 분리 자체는 블록 테스트가 본다. 여기서는 **그 블록을 쓰는지**만 확인한다.
    expect(r.names, "행동 블록을 안 쓰고 옛 인라인 마크업이 남았다").toContain("CompletionActionsBlock");
  });
});
