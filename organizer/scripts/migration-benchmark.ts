import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadLocalEnv, parsePositiveInt } from "./ops/env";

loadLocalEnv();
if (process.env.MIGRATION_BENCHMARK_CONFIRM !== "I_UNDERSTAND") {
  throw new Error("MIGRATION_BENCHMARK_CONFIRM=I_UNDERSTAND is required");
}
if (process.env.MIGRATION_BENCHMARK_ENV !== "isolated") {
  throw new Error("MIGRATION_BENCHMARK_ENV=isolated is required; never benchmark a production database");
}

async function main() {
const scale = parsePositiveInt("MIGRATION_BENCHMARK_SCALE", 100_000, 5_000_000);
const pool = new Pool({
  host: process.env.BENCHMARK_PG_HOST ?? process.env.PG_HOST,
  port: Number(process.env.BENCHMARK_PG_PORT ?? process.env.PG_PORT ?? 5432),
  user: process.env.BENCHMARK_PG_USER ?? process.env.PG_USER,
  password: process.env.BENCHMARK_PG_PASSWORD ?? process.env.PG_PASSWORD,
  database: process.env.BENCHMARK_PG_DATABASE ?? process.env.PG_DATABASE,
  max: 8,
  connectionTimeoutMillis: 10_000,
});
const suffix = `${process.pid}_${randomUUID().slice(0, 8)}`;
const tables = {
  message: `migration_bench_message_${suffix}`,
  webhook: `migration_bench_webhook_${suffix}`,
  campaign: `migration_bench_campaign_${suffix}`,
  recipient: `migration_bench_recipient_${suffix}`,
};
const indexes = [
  { key: "message", column: "(status, claim_expires_at)", where: "status = 'sending'", explain: "status = 'sending' AND claim_expires_at < NOW()" },
  { key: "webhook", column: "(status, next_attempt_at)", where: "direction = 'inbound' AND status IN ('pending', 'retrying')", explain: "direction = 'inbound' AND status IN ('pending', 'retrying') AND next_attempt_at <= NOW()" },
  { key: "campaign", column: "(status, claim_expires_at)", where: "status = 'sending'", explain: "status = 'sending' AND claim_expires_at < NOW()" },
  { key: "recipient", column: "(campaign_id, status, claim_expires_at)", where: "status = 'sending'", explain: "campaign_id = 1 AND status = 'sending' AND claim_expires_at < NOW()" },
] as const;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const timings: Array<Record<string, unknown>> = [];
let stopWriter = false;
let writerCount = 0;
let writerMaxMs = 0;

async function writer() {
  while (!stopWriter) {
    const started = Date.now();
    try {
      await pool.query(`UPDATE ${quote(tables.message)} SET updated_at = NOW() WHERE id = (SELECT id FROM ${quote(tables.message)} LIMIT 1)`);
      writerCount += 1;
      writerMaxMs = Math.max(writerMaxMs, Date.now() - started);
    } catch {
      // The benchmark reports write failures; it does not hide them from the operator.
      writerMaxMs = Math.max(writerMaxMs, Date.now() - started);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '30min'");
    await client.query(`CREATE UNLOGGED TABLE ${quote(tables.message)} (id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL, claim_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE UNLOGGED TABLE ${quote(tables.webhook)} (id BIGSERIAL PRIMARY KEY, direction TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TIMESTAMPTZ)`);
    await client.query(`CREATE UNLOGGED TABLE ${quote(tables.campaign)} (id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL, claim_expires_at TIMESTAMPTZ)`);
    await client.query(`CREATE UNLOGGED TABLE ${quote(tables.recipient)} (id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL, status TEXT NOT NULL, claim_expires_at TIMESTAMPTZ)`);
    await client.query(`INSERT INTO ${quote(tables.message)} (status, claim_expires_at) SELECT CASE WHEN n % 10 = 0 THEN 'sending' ELSE 'queued' END, NOW() + ((n % 60) || ' seconds')::interval FROM generate_series(1, $1::int) n`, [scale]);
    await client.query(`INSERT INTO ${quote(tables.webhook)} (direction, status, next_attempt_at) SELECT 'inbound', CASE WHEN n % 10 = 0 THEN 'pending' ELSE 'processed' END, NOW() + ((n % 60) || ' seconds')::interval FROM generate_series(1, $1::int) n`, [scale]);
    await client.query(`INSERT INTO ${quote(tables.campaign)} (status, claim_expires_at) SELECT CASE WHEN n % 10 = 0 THEN 'sending' ELSE 'draft' END, NOW() + ((n % 60) || ' seconds')::interval FROM generate_series(1, $1::int) n`, [scale]);
    await client.query(`INSERT INTO ${quote(tables.recipient)} (campaign_id, status, claim_expires_at) SELECT n % 1000, CASE WHEN n % 10 = 0 THEN 'sending' ELSE 'pending' END, NOW() + ((n % 60) || ' seconds')::interval FROM generate_series(1, $1::int) n`, [scale]);
  } finally {
    client.release();
  }

  const writerPromise = writer();
  for (const index of indexes) {
    const table = tables[index.key];
    const indexName = `migration_bench_idx_${index.key}_${suffix}`;
    const started = Date.now();
    const indexClient = await pool.connect();
    try {
      await indexClient.query(`CREATE INDEX CONCURRENTLY ${quote(indexName)} ON ${quote(table)} USING btree ${index.column} WHERE ${index.where}`);
    } finally {
      indexClient.release();
    }
    const durationMs = Date.now() - started;
    const plan = await pool.query(`EXPLAIN (FORMAT JSON) SELECT * FROM ${quote(table)} WHERE ${index.explain} LIMIT 10`);
    timings.push({ index: indexName, table, durationMs, explainPredicate: index.explain, plan: plan.rows[0]?.["QUERY PLAN"] ?? null });
  }
  stopWriter = true;
  await writerPromise;

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    environment: "isolated",
    scalePerTable: scale,
    tables,
    timings,
    concurrentWrites: { count: writerCount, maxLatencyMs: writerMaxMs },
    safety: { lockTimeout: "5s", statementTimeout: "30min", method: "CREATE INDEX CONCURRENTLY" },
  }, null, 2));
} finally {
  stopWriter = true;
  const cleanup = await pool.connect().catch(() => null);
  if (cleanup) {
    try {
      for (const table of Object.values(tables)) await cleanup.query(`DROP TABLE IF EXISTS ${quote(table)}`);
    } finally {
      cleanup.release();
    }
  }
  await pool.end();
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
