import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, startCronRun, finishCronRun, processAuditOutbox, captureMessage } = vi.hoisted(() => ({
  getPool: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  processAuditOutbox: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/ops/cron-run", () => ({ startCronRun, finishCronRun }));
vi.mock("@/lib/audit/outbox", () => ({ processAuditOutbox }));

import { GET } from "@/app/api/cron/drain-audit-outbox/route";

const req = (authorization = "Bearer cron-secret") => new Request("https://go.test/api/cron/drain-audit-outbox", { headers: { authorization } });

describe("drain-audit-outbox degraded reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    getPool.mockReturnValue({});
    startCronRun.mockResolvedValue({ id: "run-1" });
    finishCronRun.mockResolvedValue(undefined);
    processAuditOutbox.mockResolvedValue({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
  });

  it("healthy drain is 200/succeeded", async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "succeeded", expect.anything());
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("failed/dead row is 207/degraded and alerts Sentry", async () => {
    const summary = { claimed: 2, delivered: 0, failed: 1, dead: 1 };
    processAuditOutbox.mockResolvedValue(summary);
    const response = await GET(req());
    expect(response.status).toBe(207);
    expect((await response.json()).data.degraded).toBe(true);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "degraded", summary);
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining("audit_outbox"), expect.objectContaining({ level: "error" }));
  });

  it("rejects unauthenticated calls", async () => {
    const response = await GET(req("Bearer wrong"));
    expect(response.status).toBe(401);
    expect(processAuditOutbox).not.toHaveBeenCalled();
  });
});
