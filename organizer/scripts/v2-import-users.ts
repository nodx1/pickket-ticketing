/**
 * go DB 의 모든 user/organizer 를 v2 /api/v1/internal/users/import 로 push.
 *
 * - 응답으로 받은 v2_user_id 를 go DB 에 저장 (users.v2_user_id, organizers.v2_user_id)
 * - dry-run 기본. 실제 실행하려면 `--apply` 플래그
 * - HMAC 인증: GO_WEBHOOK_SECRET (= V2_EVENT_SYNC_SECRET)
 *
 * 실행:
 *   npx tsx scripts/v2-import-users.ts          # dry-run
 *   npx tsx scripts/v2-import-users.ts --apply   # 실제 import
 *
 * 컨테이너 (ECS) 에서 실행할 땐 .env.local 없이 process.env 만 사용.
 */
import crypto from "node:crypto";
import fs from "node:fs";

// .env.local 있으면 로드 (로컬 개발 편의)
if (fs.existsSync(".env.local")) {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const V2_BASE = process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";
const SECRET = process.env.V2_EVENT_SYNC_SECRET;
const IMPORT_PATH = "/api/v1/internal/users/import";

if (!SECRET) {
  console.error("❌ V2_EVENT_SYNC_SECRET 미설정");
  process.exit(1);
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  password_hash: string;
  role: string;
  is_active: boolean;
  v2_user_id: string | null;
  account_id: string;
  account_name: string;
  account_business_number: string | null;
  account_contact_phone: string | null;
}

interface OrganizerRow {
  id: string;
  account_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  v2_user_id: string | null;
}

interface SettlementInfo {
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
}

interface ImportPayload {
  email: string;
  name: string;
  hashed_password: string | null;
  phone: string | null;
  is_organizer: boolean;
  is_admin: boolean;
  business_name: string | null;
  business_registration_number: string | null;
  business_representative: string | null;
  business_phone: string | null;
  settlement_bank: string | null;
  settlement_account_holder: string | null;
  settlement_account_number: string | null;
  go_organizer_id: string | null;
  go_user_id: string;
}

interface ImportResponse {
  ok: boolean;
  v2_user_id: string;
  email: string;
  created: boolean;
  error?: string;
}

// v2 webhook 표준: HMAC-SHA256(secret, `${timestamp}.${body}`) hex digest.
// 헤더: X-Pickket-Signature 는 raw hex (sha256= prefix 없음).
function sign(timestamp: string, body: string): string {
  return crypto
    .createHmac("sha256", SECRET!)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

async function callImport(payload: ImportPayload): Promise<ImportResponse> {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = sign(timestamp, body);

  const res = await fetch(`${V2_BASE}${IMPORT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Signature": signature,
      "X-Pickket-Timestamp": timestamp,
      "X-Pickket-Event": "users.import",
      "X-Pickket-Delivery-Id": crypto.randomUUID(),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      v2_user_id: "",
      email: payload.email,
      created: false,
      error: `HTTP ${res.status} ${text}`,
    };
  }

  return (await res.json()) as ImportResponse;
}

async function main() {
  const { getPool } = await import("../src/lib/db/pool");
  const pool = getPool();

  console.log(`▶ V2 user import — mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  endpoint: ${V2_BASE}${IMPORT_PATH}`);

  // 1) 모든 user + 계정 + 사업자정보 join
  const { rows: users } = await pool.query<UserRow>(
    `SELECT
       u.id, u.email, u.name, u.phone,
       u.password_hash, u.role, u.is_active, u.v2_user_id,
       u.account_id,
       a.name AS account_name,
       a.business_number AS account_business_number,
       a.contact_phone AS account_contact_phone
     FROM users u
     JOIN accounts a ON a.id = u.account_id
     ORDER BY u.created_at`,
  );

  // 2) account 별 organizer 조회 (1차 host)
  const accountIds = Array.from(new Set(users.map((u) => u.account_id)));
  const { rows: organizers } = await pool.query<OrganizerRow>(
    `SELECT id, account_id, name, email, phone, v2_user_id
     FROM organizers
     WHERE account_id = ANY($1::uuid[])
     ORDER BY account_id, created_at`,
    [accountIds],
  );
  const orgByAccount = new Map<string, OrganizerRow>();
  for (const o of organizers) {
    if (!orgByAccount.has(o.account_id)) orgByAccount.set(o.account_id, o);
  }

  // 3) account 별 가장 최근 settlement bank 정보 (참고용)
  const { rows: settlements } = await pool.query<SettlementInfo & { account_id: string }>(
    `SELECT DISTINCT ON (account_id) account_id, bank_name, bank_account, bank_holder
     FROM settlements
     WHERE account_id = ANY($1::uuid[]) AND bank_name IS NOT NULL
     ORDER BY account_id, period_end DESC`,
    [accountIds],
  );
  const bankByAccount = new Map<string, SettlementInfo>();
  for (const s of settlements) bankByAccount.set(s.account_id, s);

  console.log(`  대상: users=${users.length}, organizers=${organizers.length}\n`);

  let okCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let failCount = 0;
  const failures: Array<{ email: string; error: string }> = [];

  for (const u of users) {
    const org = orgByAccount.get(u.account_id);
    const bank = bankByAccount.get(u.account_id);
    const isOrganizer = u.role === "organizer" || u.role === "owner" || Boolean(org);
    const isAdmin = u.role === "admin" || u.role === "owner";

    const payload: ImportPayload = {
      email: u.email,
      name: u.name,
      hashed_password: u.password_hash || null,
      phone: u.phone,
      is_organizer: isOrganizer,
      is_admin: isAdmin,
      business_name: u.account_name,
      business_registration_number: u.account_business_number,
      business_representative: null, // schema 에 없음
      business_phone: u.account_contact_phone,
      settlement_bank: bank?.bank_name ?? null,
      settlement_account_holder: bank?.bank_holder ?? null,
      settlement_account_number: bank?.bank_account ?? null,
      go_organizer_id: org?.id ?? null,
      go_user_id: u.id,
    };

    if (!APPLY) {
      console.log(`  [dry] ${u.email} (org=${org?.name ?? "-"}, admin=${isAdmin})`);
      okCount++;
      continue;
    }

    try {
      const res = await callImport(payload);
      if (!res.ok) throw new Error(res.error ?? "unknown");
      console.log(
        `  ✅ ${res.email}${res.created ? " (created)" : " (updated)"} → v2_user_id=${res.v2_user_id}`,
      );
      // 매핑 저장
      await pool.query(`UPDATE users SET v2_user_id = $1 WHERE id = $2`, [res.v2_user_id, u.id]);
      if (org) {
        await pool.query(`UPDATE organizers SET v2_user_id = $1 WHERE id = $2`, [
          res.v2_user_id,
          org.id,
        ]);
      }
      okCount++;
      if (res.created) createdCount++;
      else updatedCount++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${u.email} — ${message}`);
      failCount++;
      failures.push({ email: u.email, error: message });
    }
  }

  console.log("\n=== 결과 ===");
  console.log(`  ok=${okCount}, created=${createdCount}, updated=${updatedCount}, fail=${failCount}`);
  if (failures.length > 0) {
    console.log("\n실패 목록:");
    failures.forEach((f) => console.log(`  - ${f.email}: ${f.error}`));
  }

  if (!APPLY) {
    console.log("\n⚠️  dry-run 모드. 실제 적용은 --apply 플래그.");
  }

  await pool.end();
}

void main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
