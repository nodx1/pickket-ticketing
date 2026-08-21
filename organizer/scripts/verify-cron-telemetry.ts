import { getPool } from "@/lib/db/pool";
import { loadLocalEnv } from "./ops/env";

loadLocalEnv();
const expected = (process.env.CRON_TELEMETRY_JOBS ?? "retry-order-webhooks,dispatch-messages,dispatch-campaigns,reconcile-deliveries,ops-cleanup")
  .split(",").map((name) => name.trim()).filter(Boolean);
async function main() {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{
    job_name: string;
    last_started: string | null;
    last_succeeded: string | null;
    last_failed: string | null;
    currently_running: string | null;
    executions: string;
    stale_reclaimed: string;
    duplicate_claim_prevented: string;
  }>(
    `SELECT job_name,
            MAX(started_at) AS last_started,
            MAX(started_at) FILTER (WHERE status = 'succeeded') AS last_succeeded,
            MAX(started_at) FILTER (WHERE status = 'failed') AS last_failed,
            MAX(started_at) FILTER (WHERE status = 'running') AS currently_running,
            COUNT(*)::text AS executions,
            COALESCE(SUM((result->>'staleReclaimed')::int), 0)::text AS stale_reclaimed,
            COALESCE(SUM((result->>'duplicateClaimPrevented')::int), 0)::text AS duplicate_claim_prevented
       FROM ops_cron_runs
      WHERE job_name = ANY($1::text[])
      GROUP BY job_name
      ORDER BY job_name`,
    [expected],
  );
    const byName = new Map(rows.map((row) => [row.job_name, row]));
    const missing = expected.filter((name) => !byName.has(name));
    const staleRunning = rows.filter((row) => row.currently_running && Date.now() - new Date(row.currently_running).getTime() > 15 * 60_000).map((row) => row.job_name);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), expected, rows, missing, staleRunning, ready: missing.length === 0 && staleRunning.length === 0 }, null, 2));
    if (missing.length > 0 || staleRunning.length > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
