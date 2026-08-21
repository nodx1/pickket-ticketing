import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 오프라인 명부(현장발권) GET 의 **상태 필터** — 실행되는 SQL 을 캡처해 검사한다.
 *
 * 🔴 종전엔 `WHERE payment_method='offline'` 뿐이고 상태 필터가 0개였다.
 *    `checkout/initiate` 가 모든 소비자 주문을 `'offline'` 로 적어서(카드 포함),
 *    카드 결제하다 이탈해 **취소된 사람이 이 명단에 떠 있었다** — prod 에서 4명.
 *    대회 당일 이 명단을 보고 결제 안 한 사람에게 발권할 수 있다.
 *
 * ⚠️ 처음엔 파일을 읽어 정규식으로 검사했는데, **필터를 `--` 로 주석 처리하면
 *    런타임에서는 사라지는데 테스트는 통과**했다(적대검수 지적, 재현 확인).
 *    주석화가 바로 그 "조용한 소멸" 이므로, **실제로 pool 에 전달되는 SQL** 을 잡는다.
 */
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth: (fn: unknown) => (req: unknown, ctx: unknown) =>
    (fn as (r: unknown, c: unknown) => unknown)(req, {
      ...(ctx as object),
      session: { accountId: "acc-1", id: "u-1" },
    }),
}));
vi.mock("@/lib/server/require-feature", () => ({ requireFeature: async () => null }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/server/orders", () => ({ createOrder: vi.fn(), V2CommerceError: class extends Error {} }));
vi.mock("@/lib/server/rsvp-product", () => ({ ensureCompProduct: vi.fn() }));
vi.mock("@/lib/server/idempotency", () => ({ requireIdempotencyKey: () => null }));
vi.mock("@/lib/request-ip", () => ({ auditClientIp: () => "1.1.1.1" }));

import { GET } from "./route";

/** pool.query 에 실제로 전달된 SQL 에서 주석을 제거한다 — 주석 안 텍스트에 속지 않는다. */
function executedSql(): string {
  const raw = String(h.query.mock.calls[0]?.[0] ?? "");
  return raw
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))   // 라인 주석 제거
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockResolvedValue({ rows: [] });
});

async function call() {
  await GET(new Request("https://go.pickket.kr/x") as never, { params: Promise.resolve({ eventId: "ev-1" }) } as never);
}

describe("오프라인 명부 상태 필터 (실행 SQL 기준)", () => {
  it("🔴 주문 상태 필터가 **실행되는 SQL 에** 있다", async () => {
    await call();
    expect(executedSql()).toMatch(/o\.status\s+IN\s*\(/);
  });

  it("🔴 partially_refunded 를 포함한다 — 빼면 단체 부분환불 시 나머지가 사라진다", async () => {
    await call();
    const clause = executedSql().match(/o\.status\s+IN\s*\(([^)]*)\)/)?.[1] ?? "";
    expect(clause).toContain("completed");
    expect(clause).toContain("partially_refunded");
  });

  it("전액환불·취소·만료는 포함하지 않는다 (티켓이 무효다)", async () => {
    await call();
    const clause = executedSql().match(/o\.status\s+IN\s*\(([^)]*)\)/)?.[1] ?? "";
    expect(clause).not.toContain("'refunded'");
    expect(clause).not.toContain("cancelled");
    expect(clause).not.toContain("expired");
  });

  it("🔴 참석자 개별 취소(회수)도 제외한다", async () => {
    await call();
    expect(executedSql()).toMatch(/a\.status\s*<>\s*'cancelled'/);
  });
});
