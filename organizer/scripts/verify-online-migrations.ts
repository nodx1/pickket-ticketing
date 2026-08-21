import path from "node:path";
import process from "node:process";
import { getPool } from "@/lib/db/pool";

const expected = [
  "ix_message_deliveries_claim_lease",
  "ix_isw_deliveries_pending_retry",
  "ix_email_campaigns_claim_lease",
  "ix_email_campaign_recipients_claim_lease",
] as const;

async function main() {
  const pool = getPool();
  const { rows } = await pool.query<{
    index_name: string;
    table_name: string;
    definition: string;
    size_bytes: string;
  }>(
    `SELECT c.relname AS index_name,
            t.relname AS table_name,
            pg_get_indexdef(c.oid) AS definition,
            pg_relation_size(c.oid)::text AS size_bytes
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [expected],
  );
  const found = new Set(rows.map((row) => row.index_name));
  const missing = expected.filter((name) => !found.has(name));

  const blockers = await pool.query<{
    pid: number;
    relation: string | null;
    mode: string;
    state: string;
    query: string;
  }>(
    `SELECT a.pid,
            relation::regclass::text AS relation,
            mode,
            a.state,
            a.query
       FROM pg_stat_activity a
       LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
      WHERE a.pid <> pg_backend_pid()
        AND a.datname = current_database()
        AND a.state <> 'idle'
      ORDER BY a.query_start`,
  );

  console.log(JSON.stringify({
    migration: path.basename(path.resolve(process.cwd(), "migrations/205-online-index-safety.sql")),
    indexes: rows,
    missing,
    activeNonIdleSessions: blockers.rows,
    recommendation: missing.length === 0 && blockers.rows.length === 0 ? "ready" : "review",
  }, null, 2));

  if (missing.length > 0) process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end().catch(() => undefined);
  });
