import { beforeEach, describe, expect, it, vi } from "vitest";
import { V2CommerceError } from "@/lib/v2/commerce-client";

// 레벨2 재감사 P1: claim-commit 실패를 성공(201) 처리하던 결함 → 502 + 복구 큐 기록으로 교정.
const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createOrder: vi.fn(),
  getWaitlistEntry: vi.fn(),
  claimBegin: vi.fn(),
  claimCommit: vi.fn(),
  claimAbort: vi.fn(),
  verifyWaitlistOfferToken: vi.fn(),
  recordWaitlistClaimRecovery: vi.fn(),
  alertWaitlistRecovery: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/server/orders", () => ({ createOrder: h.createOrder }));
vi.mock("@/lib/v2/waitlist-client", () => ({
  getWaitlistEntry: h.getWaitlistEntry,
  claimBegin: h.claimBegin,
  claimCommit: h.claimCommit,
  claimAbort: h.claimAbort,
}));
vi.mock("@/lib/waitlist/offer-token", () => ({ verifyWaitlistOfferToken: h.verifyWaitlistOfferToken }));
vi.mock("@/lib/waitlist/claim-recovery", () => ({ recordWaitlistClaimRecovery: h.recordWaitlistClaimRecovery }));
vi.mock("@/lib/waitlist/recovery-alert", () => ({ alertWaitlistRecovery: h.alertWaitlistRecovery }));

import { POST } from "@/app/api/public/waitlist/[entryId]/claim/route";

const ENTRY_ID = "entry-1";
const ctx = { params: Promise.resolve({ entryId: ENTRY_ID }) };

function req(): Request {
  return new Request(`http://localhost/api/public/waitlist/${ENTRY_ID}/claim`, {
    method: "POST",
    body: JSON.stringify({ token: "a".repeat(40) }),
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
  });
}

const OFFERED_ENTRY = {
  id: ENTRY_ID,
  account_id: "acc-1",
  event_id: "event-1",
  product_id: "prod-1",
  name: "홍길동",
  email: "hong@example.com",
  phone: null,
  status: "offered" as const,
  offered_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  offer_token_version: 2,
  converted_order_id: null,
  created_at: null,
  updated_at: null,
};

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  h.checkRateLimit.mockResolvedValue({ success: true });
  h.verifyWaitlistOfferToken.mockReturnValue({ entryId: ENTRY_ID, version: 2, expiresAtMs: Date.now() + 3600_000 });
  h.getWaitlistEntry.mockResolvedValue({ ...OFFERED_ENTRY });
  h.claimBegin.mockResolvedValue({ claimed: true, already_claimed: false, converted_order_id: null, entry: OFFERED_ENTRY });
  h.createOrder.mockResolvedValue({ id: "order-9", orderNumber: "ORD-9", totalAmount: 10000 });
  h.recordWaitlistClaimRecovery.mockResolvedValue({ recorded: true });
});

describe("waitlist claim commit — 201 only after anchor confirmed", () => {
  it("returns 201 when claim-commit anchors the order", async () => {
    h.claimCommit.mockResolvedValue({ converted_order_id: "order-9", committed: true });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(201);
    expect(h.recordWaitlistClaimRecovery).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.data.orderId).toBe("order-9");
  });

  it("returns 201 when commit is an idempotent replay of the same order (committed=false, matching anchor)", async () => {
    h.claimCommit.mockResolvedValue({ converted_order_id: "order-9", committed: false });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(201);
    expect(h.recordWaitlistClaimRecovery).not.toHaveBeenCalled();
  });

  it("returns 502 and records recovery when claim-commit throws", async () => {
    h.claimCommit.mockRejectedValue(new V2CommerceError("commit down", 500));

    const res = await POST(req(), ctx);

    expect(res.status).toBe(502);
    expect(h.recordWaitlistClaimRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID, orderId: "order-9", accountId: "acc-1", eventId: "event-1" }),
    );
  });

  it("returns 502 and records recovery when commit anchors a different order (anchor mismatch)", async () => {
    h.claimCommit.mockResolvedValue({ converted_order_id: "order-DIFFERENT", committed: false });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(502);
    expect(h.recordWaitlistClaimRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID, orderId: "order-9" }),
    );
  });

  it("still returns 502 AND fires a Sentry alert when the recovery-queue write also fails (복구 불가 fail-safe)", async () => {
    h.claimCommit.mockRejectedValue(new Error("commit down"));
    h.recordWaitlistClaimRecovery.mockResolvedValue({ recorded: false });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(502);
    expect(h.recordWaitlistClaimRecovery).toHaveBeenCalled();
    // 큐 기록마저 실패 → 드레인 워커가 손댈 수 없는 복구 불가 상태 → 반드시 Sentry 승격.
    expect(h.alertWaitlistRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "queue_write_failed",
        entryId: ENTRY_ID,
        orderId: "order-9",
        accountId: "acc-1",
        eventId: "event-1",
      }),
    );
  });

  it("does NOT fire the queue-write alert when the recovery-queue write succeeds (드레인이 처리)", async () => {
    h.claimCommit.mockRejectedValue(new Error("commit down"));
    h.recordWaitlistClaimRecovery.mockResolvedValue({ recorded: true });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(502);
    expect(h.recordWaitlistClaimRecovery).toHaveBeenCalled();
    expect(h.alertWaitlistRecovery).not.toHaveBeenCalled();
  });

  it("does not record recovery when createOrder fails (abort path, not commit path)", async () => {
    h.createOrder.mockRejectedValue(new V2CommerceError("order fail", 502));
    h.claimAbort.mockResolvedValue({});

    const res = await POST(req(), ctx);

    expect(res.status).toBe(502);
    expect(h.claimAbort).toHaveBeenCalledWith(ENTRY_ID);
    expect(h.claimCommit).not.toHaveBeenCalled();
    expect(h.recordWaitlistClaimRecovery).not.toHaveBeenCalled();
  });
});
