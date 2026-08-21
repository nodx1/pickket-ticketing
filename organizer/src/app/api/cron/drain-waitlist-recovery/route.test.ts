import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * drain-waitlist-recovery cron — 레벨2 재감사 P1: 재-commit 최종 실패(manual_review)가 남으면
 * succeeded 로 위장하지 않고 degraded(207)로 전파한다. CRON_SECRET 가드.
 */
const { getPool, startCronRun, finishCronRun, processWaitlistClaimRecovery } = vi.hoisted(() => ({
  getPool: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  processWaitlistClaimRecovery: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/ops/cron-run", () => ({ startCronRun, finishCronRun }));
vi.mock("@/lib/waitlist/claim-recovery-drain", () => ({ processWaitlistClaimRecovery }));

import { GET } from "@/app/api/cron/drain-waitlist-recovery/route";

const HEALTHY = { claimed: 0, resolved: 0, failed: 0, manualReview: 0 };

function req(auth = "Bearer test-secret") {
  return new Request("https://go.pickket.kr/api/cron/drain-waitlist-recovery", {
    headers: { authorization: auth },
  });
}

describe("drain-waitlist-recovery cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    getPool.mockReturnValue({ query: vi.fn() });
    startCronRun.mockResolvedValue({ id: "run-1", startedAt: Date.now() });
    finishCronRun.mockResolvedValue(undefined);
    processWaitlistClaimRecovery.mockResolvedValue(HEALTHY);
  });

  it("전부 정상이면 200 succeeded", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(processWaitlistClaimRecovery).toHaveBeenCalledOnce();
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "succeeded", expect.anything());
  });

  it("일시 failed(재시도 대기)도 207 degraded로 전파", async () => {
    processWaitlistClaimRecovery.mockResolvedValue({ ...HEALTHY, claimed: 1, failed: 1 });
    const res = await GET(req());
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data.failed).toBe(1);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "degraded", expect.anything());
  });

  it("manual_review 가 남으면 207 degraded + finishCronRun('degraded')", async () => {
    processWaitlistClaimRecovery.mockResolvedValue({ ...HEALTHY, claimed: 1, manualReview: 1 });
    const res = await GET(req());
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data.manualReview).toBe(1);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "degraded", expect.anything());
  });

  it("인증 실패는 401 (드레인 미실행)", async () => {
    const res = await GET(req("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(processWaitlistClaimRecovery).not.toHaveBeenCalled();
  });

  it("드레인 예외는 failed 기록 후 500", async () => {
    processWaitlistClaimRecovery.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", undefined, expect.anything());
  });
});
