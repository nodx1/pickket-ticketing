import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

interface CronRunHandle {
  id: string;
  startedAt: number;
}

function jsonSummary(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= 20_000 ? serialized : JSON.stringify({ truncated: true });
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export async function startCronRun(pool: Pick<Pool, "query">, jobName: string): Promise<CronRunHandle> {
  const fallback = { id: randomUUID(), startedAt: Date.now() };
  try {
    const result = await pool.query<{ id: string; started_at: string }>(
      `INSERT INTO ops_cron_runs (job_name, status, started_at)
       VALUES ($1, 'running', NOW())
       RETURNING id, started_at`,
      [jobName],
    );
    const row = result.rows[0];
    return row ? { id: row.id, startedAt: new Date(row.started_at).getTime() } : fallback;
  } catch {
    // Observability must never turn a recovery job into a recovery outage.
    // The route still emits its normal structured error/result log.
    return fallback;
  }
}

export async function finishCronRun(
  pool: Pick<Pool, "query">,
  handle: CronRunHandle,
  status: "succeeded" | "failed" | "degraded",
  result?: unknown,
  error?: unknown,
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - handle.startedAt);
  await pool.query(
    `UPDATE ops_cron_runs
        SET status = $2,
            finished_at = NOW(),
            duration_ms = $3,
            result = $4::jsonb,
            error_summary = $5
      WHERE id = $1`,
    [handle.id, status, durationMs, jsonSummary(result), error instanceof Error ? error.message.slice(0, 1000) : error ? String(error).slice(0, 1000) : null],
  ).catch(() => undefined);
}

export async function withCronRun<T>(
  pool: Pick<Pool, "query">,
  jobName: string,
  work: () => Promise<T>,
): Promise<T> {
  const handle = await startCronRun(pool, jobName);
  try {
    const result = await work();
    await finishCronRun(pool, handle, "succeeded", result);
    return result;
  } catch (error) {
    await finishCronRun(pool, handle, "failed", undefined, error);
    throw error;
  }
}
