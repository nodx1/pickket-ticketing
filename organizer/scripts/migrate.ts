import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";

// .env.local 자동 로딩 (Next.js 외부 실행 시)
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const migrationsDir = path.resolve(process.cwd(), "migrations");

function getMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

async function ensureMigrationsTable(executor: Pick<PoolClient, "query"> | ReturnType<typeof getPool> = getPool()) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum TEXT
    )
  `);
  // 158 이전 DB 대응 — 컬럼이 없으면 추가
  await executor.query(
    `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`,
  );
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

interface AppliedRow {
  filename: string;
  checksum: string | null;
}

async function getAppliedMigrations(executor: Pick<PoolClient, "query"> | ReturnType<typeof getPool> = getPool()): Promise<Map<string, string | null>> {
  const { rows } = await executor.query<AppliedRow>(
    "SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC",
  );
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

const MIGRATION_LOCK_KEY = 9483721;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireLock(): Promise<PoolClient> {
  const pool = getPool();
  // Hold a session-level lock on a dedicated connection for the complete
  // migration sequence. It creates no long-lived transaction snapshot, so
  // REINDEX/CREATE INDEX CONCURRENTLY on the separate work client can finish.
  const client = await pool.connect();
  await client.query("SET lock_timeout = '15min'");
  await client.query("SET statement_timeout = '30min'");
  // Do not issue a blocking pg_advisory_lock call. A waiter is itself a
  // virtual transaction and PostgreSQL REINDEX CONCURRENTLY can deadlock
  // against that waiter while the holder is rebuilding an index.
  for (;;) {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [MIGRATION_LOCK_KEY],
    );
    if (rows[0]?.acquired) break;
    await sleep(250);
  }
  return client;
}

async function releaseLock(client: PoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
  } finally {
    client.release();
  }
}

function isNonTransactionalMigration(sql: string): boolean {
  return /^\s*--\s*@nontransactional\b/im.test(sql);
}

function splitNonTransactionalStatements(sql: string): string[] {
  // The marker is intentionally limited to short DDL such as
  // CREATE/REINDEX INDEX CONCURRENTLY. Splitting those statements before
  // sending them through node-postgres avoids the driver's implicit
  // multi-statement transaction wrapper. Transactional migrations continue to
  // use the full SQL document unchanged (and therefore support functions/
  // dollar-quoted bodies).
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function runStatus() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = getMigrationFiles();

  for (const file of files) {
    const label = applied.has(file) ? "적용됨" : "대기중";
    console.log(`${label} - ${file}`);
  }
}

/**
 * 체크섬 검증: 이미 적용된 마이그레이션이 사후 편집됐는지 감지.
 * - DB checksum이 NULL이면 backfill (158 이전 적용분)
 * - DB checksum과 파일 checksum이 다르면 에러 throw
 */
async function verifyOrBackfillChecksum(
  filename: string,
  sql: string,
  storedChecksum: string | null,
  executor: Pick<PoolClient, "query"> | ReturnType<typeof getPool> = getPool(),
): Promise<void> {
  const fileChecksum = sha256(sql);
  if (storedChecksum === null) {
    await executor.query(
      "UPDATE schema_migrations SET checksum = $1 WHERE filename = $2",
      [fileChecksum, filename],
    );
    return;
  }
  if (storedChecksum !== fileChecksum) {
    throw new Error(
      `마이그레이션 체크섬 불일치 — ${filename}\n  DB: ${storedChecksum}\n  파일: ${fileChecksum}\n적용된 마이그레이션은 사후 편집하지 마세요. 변경이 필요하면 새 마이그레이션을 추가하세요.`,
    );
  }
}

async function runMigrations({ dryRun = false }: { dryRun?: boolean }) {
  const pool = getPool();
  const lockClient = await acquireLock();
  const workClient = await pool.connect();

  try {
    // Schema bootstrap must also be serialized. CREATE TABLE IF NOT EXISTS is
    // not sufficient when two fresh migration tasks race through PostgreSQL's
    // catalog initialization concurrently.
    await ensureMigrationsTable(workClient);
    const applied = await getAppliedMigrations(workClient);
    const files = getMigrationFiles();

    // 1) 이미 적용된 마이그레이션 전수 — 체크섬 검증/backfill
    for (const file of files) {
      if (!applied.has(file)) continue;
      const fullPath = path.join(migrationsDir, file);
      if (!fs.existsSync(fullPath)) continue;
      const sql = fs.readFileSync(fullPath, "utf8");
      await verifyOrBackfillChecksum(file, sql, applied.get(file) ?? null, workClient);
    }

    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log("적용할 마이그레이션이 없습니다.");
      return;
    }

    if (dryRun) {
      for (const file of pending) {
        console.log(`DRY RUN - ${file}`);
      }
      return;
    }

    for (const file of pending) {
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, "utf8");
      const checksum = sha256(sql);
      const client = workClient;

      if (isNonTransactionalMigration(sql)) {
        // CREATE/REINDEX INDEX CONCURRENTLY cannot run inside a transaction.
        // The migration itself is idempotent; only its bookkeeping is wrapped
        // in a short transaction after all statements succeed. If a deploy is
        // interrupted, rerunning the concurrent statements is safe.
        await client.query("SET lock_timeout = '5s'");
        await client.query("SET statement_timeout = '15min'");
        try {
          for (const statement of splitNonTransactionalStatements(sql)) {
            await client.query(statement);
          }
          await client.query("BEGIN");
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          await client.query("COMMIT");
          console.log(`적용 완료 - ${file} (non-transactional)`);
        } catch (err: unknown) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          await client.query("RESET lock_timeout").catch(() => undefined);
          await client.query("RESET statement_timeout").catch(() => undefined);
        }
        continue;
      }

      try {
        await client.query("BEGIN");
        // Existing migration files are immutable, so the runner provides the
        // deployment-wide guardrail for any future blocking DDL as well.
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15min'");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log(`적용 완료 - ${file}`);
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    workClient.release();
    await releaseLock(lockClient);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--status")) {
    await runStatus();
    return;
  }

  await runMigrations({
    dryRun: args.has("--dry-run"),
  });
}

main()
  .catch((err: unknown) => {
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = getPool();
    await pool.end().catch(() => undefined);
  });
