import { describe, expect, it, vi } from "vitest";
import { finishCronRun, startCronRun, withCronRun } from "@/lib/ops/cron-run";

describe("cron telemetry", () => {
  it("records start and finish without exposing the work result to SQL", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "run-1", started_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query };

    const result = await withCronRun(pool, "audit-job", async () => ({ unknown: 2, providerSecret: "never-log" }));

    expect(result).toEqual({ unknown: 2, providerSecret: "never-log" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("INSERT INTO ops_cron_runs");
    expect(String(query.mock.calls[1]?.[0])).toContain("UPDATE ops_cron_runs");
    expect(query.mock.calls[1]?.[1]?.[3]).toContain("unknown");
  });

  it("does not hide a failed recovery job and records a bounded error", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "run-2", started_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query };

    await expect(withCronRun(pool, "audit-job", async () => {
      throw new Error("provider failure");
    })).rejects.toThrow("provider failure");
    expect(query.mock.calls[1]?.[1]?.[1]).toBe("failed");
    expect(query.mock.calls[1]?.[1]?.[4]).toBe("provider failure");
  });

  it("observability write failures never block the recovery path", async () => {
    const query = vi.fn().mockRejectedValue(new Error("telemetry DB unavailable"));
    const pool = { query };
    const handle = await startCronRun(pool, "audit-job");
    await expect(finishCronRun(pool, handle, "succeeded", { ok: true })).resolves.toBeUndefined();
  });
});
