import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { transitionOrder, transitionOrderDetailed } from "@/lib/state-machine/order-state-machine";

function clientFor(...results: unknown[]) {
  return { query: vi.fn().mockResolvedValueOnce(results[0]).mockResolvedValueOnce(results[1]) } as unknown as PoolClient;
}

describe("order state transition expiry guard", () => {
  it("reports expired instead of a generic false result", async () => {
    const client = clientFor(
      { rowCount: 0, rows: [] },
      { rows: [{ status: "pending", expires_at: new Date(Date.now() - 1_000) }] },
    );

    await expect(
      transitionOrderDetailed(client, "order-1", "pending", "completed"),
    ).resolves.toEqual({ status: "condition_failed", reason: "expired" });
  });

  it("keeps the legacy boolean API false for an expired order", async () => {
    const client = clientFor(
      { rowCount: 0, rows: [] },
      { rows: [{ status: "pending", expires_at: new Date(Date.now() - 1_000) }] },
    );

    await expect(transitionOrder(client, "order-1", "pending", "completed")).resolves.toBe(false);
  });

  it("distinguishes a concurrent state change from expiry", async () => {
    const client = clientFor(
      { rowCount: 0, rows: [] },
      { rows: [{ status: "completed", expires_at: null }] },
    );

    await expect(
      transitionOrderDetailed(client, "order-1", "pending", "completed"),
    ).resolves.toEqual({ status: "condition_failed", reason: "concurrent_change" });
  });

  it("still applies valid non-expired transitions", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "order-1" }] }) } as unknown as PoolClient;

    await expect(
      transitionOrderDetailed(client, "order-1", "pending", "completed"),
    ).resolves.toEqual({ status: "applied" });
  });
});
