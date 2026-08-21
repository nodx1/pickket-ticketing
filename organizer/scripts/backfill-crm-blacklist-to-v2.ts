/**
 * W3-MSG 이관 스크립트 — go 컴플라이언스 원장 → v2.
 *
 * 대상 3종(전부 go DB → v2 `message_suppressions` / `message_consents`):
 *   1. `crm_contacts` 중 tier='blacklist'  → 억제(channel='all', reason='manual')
 *      ⚠️ 구 블랙리스트는 **이메일 키**로 매칭해 SMS 발송까지 막았다. 신규 억제는 연락처
 *         문자열 기준이므로 이메일과 전화 **각각** 행을 만든다(누락 시 블랙리스트 대상에게
 *         SMS 가 나간다).
 *   2. `message_suppressions`               → 그대로 억제 이관(사유·채널 보존)
 *   3. `message_consents`                   → 그대로 동의 이관(야간동의·문구버전 보존)
 *
 * 실측(2026-07-27): prod·dev 모두 crm_contacts 0행 / blacklist 0행. 이 스크립트는
 * **계약을 코드로 남기고 타 환경 대비**하는 용도다. 그래도 DROP(mig243) 전에 --dry-run 으로
 * 0 을 확인하는 것이 절차다.
 *
 * 사용:
 *   npx tsx scripts/backfill-crm-blacklist-to-v2.ts --dry-run   # 대상만 집계(기본값)
 *   npx tsx scripts/backfill-crm-blacklist-to-v2.ts --apply     # 실제 v2 write
 *
 * 멱등: v2 upsert 는 ON CONFLICT DO NOTHING(억제) / UPSERT(동의)라 여러 번 돌려도 안전하다.
 * 실패 시 **중단**한다 — 일부만 이관된 채 DROP 하면 억제 유실(= 수신거부자 발송)이 된다.
 */
import { getPool } from "@/lib/db/pool";
import {
  grantConsent,
  upsertSuppression,
  type ComplianceChannel,
  type SuppressionChannel,
  type SuppressionReason,
} from "@/lib/v2/messaging-compliance-client";

const apply = process.argv.includes("--apply");

interface BlacklistRow {
  account_id: string;
  email: string | null;
  phone: string | null;
}
interface SuppressionRow {
  account_id: string | null;
  contact: string;
  channel: string;
  reason: string;
}
interface ConsentRow {
  account_id: string;
  contact: string;
  channel: string;
  consented: boolean;
  night_consented: boolean;
  source: string | null;
  wording_version: string | null;
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS ok",
    [name],
  );
  return rows[0]?.ok === true;
}

async function main(): Promise<void> {
  let planned = 0;
  let done = 0;

  // ── 1) CRM 블랙리스트 ──────────────────────────────────────────────
  if (await tableExists("crm_contacts")) {
    const { rows } = await getPool().query<BlacklistRow>(
      "SELECT account_id, email, phone FROM crm_contacts WHERE tier = 'blacklist'",
    );
    console.log(`crm_contacts(blacklist): ${rows.length}건`);
    for (const r of rows) {
      // 이메일·전화 각각 전채널('all') 억제로 이관.
      const targets = [r.email, r.phone].filter((c): c is string => Boolean(c && c.trim()));
      for (const contact of targets) {
        planned += 1;
        if (!apply) continue;
        await upsertSuppression(r.account_id, "all", contact, "manual");
        done += 1;
      }
    }
  } else {
    console.log("crm_contacts: 테이블 없음(이미 DROP) — 건너뜀");
  }

  // ── 2) 기존 억제 원장 ─────────────────────────────────────────────
  if (await tableExists("message_suppressions")) {
    const { rows } = await getPool().query<SuppressionRow>(
      "SELECT account_id, contact, channel, reason FROM message_suppressions",
    );
    console.log(`message_suppressions: ${rows.length}건`);
    for (const r of rows) {
      planned += 1;
      if (!apply) continue;
      await upsertSuppression(
        r.account_id,
        r.channel as SuppressionChannel,
        r.contact,
        r.reason as SuppressionReason,
      );
      done += 1;
    }
  }

  // ── 3) 수신동의 원장 ──────────────────────────────────────────────
  if (await tableExists("message_consents")) {
    const { rows } = await getPool().query<ConsentRow>(
      `SELECT account_id, contact, channel, consented, night_consented, source, wording_version
       FROM message_consents`,
    );
    console.log(`message_consents: ${rows.length}건`);
    for (const r of rows) {
      planned += 1;
      if (!apply) continue;
      await grantConsent(r.account_id, r.channel as ComplianceChannel, r.contact, {
        consented: r.consented,
        nightConsented: r.night_consented,
        source: r.source ?? undefined,
        wordingVersion: r.wording_version ?? undefined,
      });
      done += 1;
    }
  }

  console.log(
    apply ? `이관 완료: ${done}/${planned}건` : `dry-run: 이관 대상 ${planned}건 (--apply 로 실행)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // 부분 이관 상태로 종료 — DROP 전에 반드시 재실행해 0 실패를 확인할 것.
    console.error("이관 실패(중단):", err instanceof Error ? err.message : err);
    process.exit(1);
  });
