/**
 * E2E 테스트 계정을 v2(인증 SSOT)에 프로비저닝.
 *
 * 배경: BFF cutover 후 로그인은 v2 가 검증한다(go password_hash 미사용). 그런데 go 시드가
 *   만드는 테스트 계정(demo@pickket.kr)이 v2 에 없고, 옛 시드 비번 'pickket1234' 는 v2
 *   비번정책(대문자 1자 이상)을 위반해 v2 계정 생성 자체가 불가하다.
 *   → E2E 가 demo@ 로 로그인 시도 → v2 401 → 3회 후 계정잠금(429) → 모든 인증테스트 연쇄실패.
 *
 * 이 스크립트(test-prepare 가 시드 직후 호출): 테스트 계정을 v2 register API 로 멱등 생성하고,
 *   go users 앵커의 v2_user_id 를 v2 canonical id 로 동기화한다(organizer_ref 정합).
 *
 * 비번: E2E_TEST_PASSWORD(기본 'Test1234!') — v2 정책 준수. helpers/auth.ts·seed.ts 와 동일값 유지.
 *
 * NOTE: 이미 v2 에 존재하나 비번 미상인 계정(organizer@/admin@ 등)은 register 가 멱등 no-op 이라
 *   비번을 못 바꾼다 → 해당 RBAC 전용 계정은 v2 측 비번 리셋/프로비저닝 조율 필요(별도 트랙).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { getPool } from "@/lib/db/pool";
import { pushOrganizerProfileToV2 } from "@/lib/v2/organizer-sync";

const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

const V2_BASE = (process.env.V2_INTERNAL_BASE_URL ?? "http://localhost:8021").replace(/\/$/, "");
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "Test1234!";

interface TestAccount {
  email: string;
  name: string;
  is_organizer: boolean;
}

// 시드(scripts/seed.ts)가 만드는 계정과 정합. demo@ 는 주력 owner 계정(대부분 테스트가 사용).
const ACCOUNTS: TestAccount[] = [
  { email: "demo@pickket.kr", name: "픽켓 데모", is_organizer: true },
  { email: "organizer@pickket.kr", name: "픽켓 운영자", is_organizer: true },
  { email: "admin@pickket.kr", name: "픽켓 관리자", is_organizer: true },
];

async function registerOnV2(acct: TestAccount): Promise<string | null> {
  const res = await fetch(`${V2_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: acct.email,
      password: PASSWORD,
      name: acct.name,
      phone: null,
      is_organizer: acct.is_organizer,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 201 || res.ok) {
    const body = (await res.json()) as { user?: { id?: string } };
    return body.user?.id ?? null;
  }
  // 이미 존재 → 로그인으로 canonical id 회수 시도(비번이 PASSWORD 와 같을 때만 성공).
  const loginRes = await fetch(`${V2_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: acct.email, password: PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (loginRes.ok) {
    const body = (await loginRes.json()) as { user?: { id?: string } };
    return body.user?.id ?? null;
  }
  const txt = await res.text().catch(() => "");
  console.warn(`[provision] ${acct.email}: 등록/로그인 실패(${res.status}) — RBAC 시 v2 비번조율 필요. ${txt.slice(0, 120)}`);
  return null;
}

async function main() {
  const pool = getPool();
  let synced = 0;
  for (const acct of ACCOUNTS) {
    try {
      const v2Id = await registerOnV2(acct);
      if (v2Id) {
        // go 앵커의 v2_user_id 를 canonical 로 강제 동기화(stale 매핑 교정).
        await pool.query("UPDATE users SET v2_user_id = $1, updated_at = NOW() WHERE email = $2", [v2Id, acct.email]);
        synced++;
        console.log(`[provision] ${acct.email} → v2 ${v2Id} (go 동기화)`);
      }
    } catch (err: unknown) {
      console.warn(`[provision] ${acct.email}: 예외 — ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  console.log(`[provision] 완료 — ${synced}/${ACCOUNTS.length} v2 프로비저닝/동기화`);

  // ── organizer_profile 등록 ───────────────────────────────────────────────
  // v2 는 organizer_ref={go_account_id} 를 OrganizerProfile.go_account_id 로 해석한다.
  // user 등록만으론 이 프로필이 안 생겨 event-create write-through 가 502(커머스 동기화 실패).
  // → 테스트 계정들의 distinct go account 를 v2 organizer_profiles 로 import(owner v2_user_id 필요).
  const { rows: accts } = await pool.query<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM users WHERE email = ANY($1) AND account_id IS NOT NULL`,
    [ACCOUNTS.map((a) => a.email)],
  );
  let profiles = 0;
  for (const { account_id } of accts) {
    try {
      const profileId = await pushOrganizerProfileToV2(account_id);
      if (profileId) {
        profiles++;
        console.log(`[provision] organizer_profile import: account ${account_id} → ${profileId}`);
      } else {
        console.warn(`[provision] organizer_profile import 스킵: account ${account_id} (owner v2_user_id 누락?)`);
      }
    } catch (err: unknown) {
      console.warn(`[provision] organizer_profile import 실패: account ${account_id} — ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  console.log(`[provision] organizer_profile — ${profiles}/${accts.length} import`);
  await pool.end().catch(() => undefined);
}

main().catch((err: unknown) => {
  console.error("[provision] 치명적:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
