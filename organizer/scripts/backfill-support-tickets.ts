/**
 * 통합 문의 원장 수렴 백필 (배치 E — CS 파운데이션 §2-2).
 *
 * inbound_emails · event_inquiries · public_chat_sessions 3테이블을
 * support_tickets / support_messages (마이그레이션 217/218) 로 멱등 수렴한다.
 *
 * 멱등성:
 *   - support_tickets: UNIQUE(legacy_source_table, legacy_source_id) → 재실행 시 티켓 중복 없음.
 *   - support_messages: UNIQUE(legacy_source_table, legacy_source_id, direction, legacy_seq)
 *     → 재실행 시 파생 메시지 중복 없음. 2회 실행 → 행수 불변.
 *
 * 검증교정 반영:
 *   - inbound_emails.status 는 CHECK 없는 자유 TEXT(098) → status 매핑 CASE 에 ELSE 'open' 기본값.
 *   - support_tickets.event_id 는 nullable → 이벤트 미매칭 메일도 '미분류'로 백필(조용한 유실 금지).
 *   - account_id 는 NOT NULL → event_id=NULL 행은 assigned_to 또는 SUPPORT_FALLBACK_ACCOUNT_ID 로 귀속.
 *     둘 다 없으면 스킵 + 로그(보류) — 결코 조용히 버리지 않는다.
 *
 * 사용:
 *   npx tsx scripts/backfill-support-tickets.ts            # dry-run (집계만, 쓰기 없음)
 *   npx tsx scripts/backfill-support-tickets.ts --apply    # 실제 수렴
 *
 * ⚠️ 적용 창(window): 이 스크립트는 217/218(대상 테이블 생성) 이후 ~ 222/225(테이블 DROP) 이전에만
 *   실행할 수 있다. 창을 벗어나면 아래 하드 가드가 즉시 중단한다.
 *     - 원본 테이블: inbound_emails · event_inquiries · public_chat_sessions
 *         (public_chat_sessions 는 mig222 에서 DROP → 222 이후 read 불가)
 *     - 대상 테이블: support_tickets · support_messages
 *         (mig225 에서 DROP → 225 이후 INSERT 대상 부재)
 *   ⚠️ mig225 판정(LEVEL2-GO-UNIQUE-DISPOSITION): 이 CS 수렴층은 **라이브 코드 참조 0·prod 데이터 0**
 *     으로 폐기되었다. 대상 테이블이 영구 DROP 되었으므로 신규 배포 환경에서 이 스크립트는 실질 사문(死文)
 *     이다. 잔존은 이력·마이그 창 내 재현용이며, 창 밖에서는 원본/대상 존재검사로 조용한 실패를 차단한다.
 */
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

const APPLY = process.argv.includes("--apply");
const FALLBACK_ACCOUNT_ID = process.env.SUPPORT_FALLBACK_ACCOUNT_ID?.trim() || null;

interface Counters {
  inserted: number;
  skipped: number;
}

async function assertRequiredTables(client: PoolClient): Promise<void> {
  // 원본(read) + 대상(write) 테이블을 모두 하드 검사한다. 하나라도 없으면(마이그 창 밖) 즉시 중단 —
  // INSERT 중간에서 "relation ... does not exist" 로 부분 실패/애매한 크래시가 나기 전에 명시적으로 막는다.
  //   원본 누락(예: public_chat_sessions) → mig222 이후.
  //   대상 누락(support_tickets/support_messages) → mig225 이후(CS 수렴층 폐기).
  const { rows } = await client.query<{ table_name: string | null; kind: string }>(
    `SELECT t.table_name, t.kind
       FROM (VALUES
               ('inbound_emails', 'source'),
               ('event_inquiries', 'source'),
               ('public_chat_sessions', 'source'),
               ('support_tickets', 'target'),
               ('support_messages', 'target')
            ) AS t(table_name, kind)
      WHERE to_regclass('public.' || t.table_name) IS NULL`,
  );
  if (rows.length > 0) {
    const missingSource = rows.filter((r) => r.kind === "source").map((r) => r.table_name);
    const missingTarget = rows.filter((r) => r.kind === "target").map((r) => r.table_name);
    const parts: string[] = [];
    if (missingSource.length > 0) {
      parts.push(`원본 테이블 부재(${missingSource.join(", ")}) — mig222 이후로 추정`);
    }
    if (missingTarget.length > 0) {
      parts.push(
        `대상 테이블 부재(${missingTarget.join(", ")}) — mig225(CS 수렴층 폐기) 이후. ` +
          "이 백필은 더 이상 적용 대상이 아닙니다(사문)",
      );
    }
    throw new Error(
      `백필 중단: ${parts.join(" / ")}. 이 스크립트는 mig217/218 이후 ~ mig222/225 이전 창에서만 실행됩니다.`,
    );
  }
}

function newCounters(): Counters {
  return { inserted: 0, skipped: 0 };
}

/**
 * inbound_emails.status → support_tickets.status.
 * 자유 TEXT(CHECK 없음)라 비정형 값이 존재할 수 있으므로 ELSE 기본값 open 방어.
 */
function mapEmailStatus(status: string | null): string {
  switch (status) {
    case "replied":
      return "answered";
    case "archived":
      return "archived";
    case "new":
      return "open";
    default:
      return "open"; // 비정형/NULL → open (조용한 유실·CHECK 위반 방지)
  }
}

function mapInquiryStatus(status: string | null): string {
  switch (status) {
    case "answered":
      return "answered";
    case "archived":
      return "archived";
    case "open":
      return "open";
    default:
      return "open";
  }
}

interface InboundEmailRow {
  id: string;
  event_id: string | null;
  account_id: string | null; // events join 결과(nullable: 미매칭 메일)
  assigned_to: string | null;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  reply_body: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
  replied_at: string | null;
}

async function backfillInboundEmails(client: PoolClient, c: Counters): Promise<void> {
  const { rows } = await client.query<InboundEmailRow>(
    `SELECT ie.id, ie.event_id, ev.account_id, ie.assigned_to,
            ie.from_email, ie.from_name, ie.subject, ie.body_text,
            ie.reply_body, ie.status, ie.created_at, ie.updated_at, ie.replied_at
       FROM inbound_emails ie
       LEFT JOIN events ev ON ev.id = ie.event_id
      WHERE NOT EXISTS (
        SELECT 1 FROM support_tickets st
         WHERE st.legacy_source_table = 'inbound_emails' AND st.legacy_source_id = ie.id
      )`,
  );

  for (const r of rows) {
    // account_id 결정: event 소속 계정 → assigned_to → 환경 fallback. 없으면 스킵(보류).
    const accountId = r.account_id ?? r.assigned_to ?? FALLBACK_ACCOUNT_ID;
    if (!accountId) {
      c.skipped += 1;
      console.warn(
        `[skip] inbound_emails ${r.id}: account_id 미결정(event 미매칭 + assigned_to 없음 + SUPPORT_FALLBACK_ACCOUNT_ID 미설정). 보류.`,
      );
      continue;
    }

    const status = mapEmailStatus(r.status);
    const customerKey = `email:${r.from_email.trim().toLowerCase()}`;

    if (!APPLY) {
      c.inserted += 1;
      continue;
    }

    const { rows: ticketRows } = await client.query<{ id: string }>(
      `INSERT INTO support_tickets
         (event_id, account_id, source, customer_key, customer_contact, customer_name,
          subject, status, legacy_source_table, legacy_source_id, last_message_at, created_at, updated_at)
       VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, 'inbound_emails', $8, $9, $10, $11)
       ON CONFLICT (legacy_source_table, legacy_source_id) WHERE legacy_source_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [
        r.event_id,
        accountId,
        customerKey,
        r.from_email.trim(),
        r.from_name,
        r.subject,
        status,
        r.id,
        r.replied_at ?? r.updated_at ?? r.created_at,
        r.created_at,
        r.updated_at,
      ],
    );

    // 경합/재실행으로 이미 존재하면 티켓 id 를 조회해서 메시지 upsert 이어감.
    let ticketId = ticketRows[0]?.id;
    if (!ticketId) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM support_tickets
          WHERE legacy_source_table = 'inbound_emails' AND legacy_source_id = $1 LIMIT 1`,
        [r.id],
      );
      ticketId = existing[0]?.id;
    }
    if (!ticketId) {
      c.skipped += 1;
      continue;
    }

    // inbound: 원문 본문
    await client.query(
      `INSERT INTO support_messages
         (ticket_id, direction, body, author, origin, legacy_source_table, legacy_source_id, legacy_seq, created_at)
       VALUES ($1, 'inbound', $2, 'customer', 'import', 'inbound_emails', $3, 0, $4)
       ON CONFLICT (legacy_source_table, legacy_source_id, direction, legacy_seq)
         WHERE legacy_source_id IS NOT NULL DO NOTHING`,
      [ticketId, r.body_text ?? "", r.id, r.created_at],
    );

    // outbound: reply_body 있으면 발송본(origin=manual)
    if (r.reply_body && r.reply_body.trim().length > 0) {
      await client.query(
        `INSERT INTO support_messages
           (ticket_id, direction, body, author, origin, legacy_source_table, legacy_source_id, legacy_seq, created_at)
         VALUES ($1, 'outbound', $2, 'organizer', 'manual', 'inbound_emails', $3, 1, $4)
         ON CONFLICT (legacy_source_table, legacy_source_id, direction, legacy_seq)
           WHERE legacy_source_id IS NOT NULL DO NOTHING`,
        [ticketId, r.reply_body, r.id, r.replied_at ?? r.updated_at ?? r.created_at],
      );
    }

    c.inserted += 1;
  }
}

interface InquiryRow {
  id: string;
  event_id: string;
  account_id: string;
  contact: string | null;
  question: string;
  answer: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

async function backfillEventInquiries(client: PoolClient, c: Counters): Promise<void> {
  const { rows } = await client.query<InquiryRow>(
    `SELECT id, event_id, account_id, contact, question, answer, status, created_at, updated_at
       FROM event_inquiries ei
      WHERE NOT EXISTS (
        SELECT 1 FROM support_tickets st
         WHERE st.legacy_source_table = 'event_inquiries' AND st.legacy_source_id = ei.id
      )`,
  );

  for (const r of rows) {
    const status = mapInquiryStatus(r.status);
    const normalizedContact = r.contact?.trim().toLowerCase();
    const customerKey = normalizedContact ? `web:${normalizedContact}` : `web:${r.id}`;

    if (!APPLY) {
      c.inserted += 1;
      continue;
    }

    const { rows: ticketRows } = await client.query<{ id: string }>(
      `INSERT INTO support_tickets
         (event_id, account_id, source, customer_key, customer_contact, status,
          legacy_source_table, legacy_source_id, last_message_at, created_at, updated_at)
       VALUES ($1, $2, 'web', $3, $4, $5, 'event_inquiries', $6, $7, $8, $9)
       ON CONFLICT (legacy_source_table, legacy_source_id) WHERE legacy_source_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [
        r.event_id,
        r.account_id,
        customerKey,
        r.contact?.trim() ?? null,
        status,
        r.id,
        r.answer ? r.updated_at : r.created_at,
        r.created_at,
        r.updated_at,
      ],
    );

    let ticketId = ticketRows[0]?.id;
    if (!ticketId) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM support_tickets
          WHERE legacy_source_table = 'event_inquiries' AND legacy_source_id = $1 LIMIT 1`,
        [r.id],
      );
      ticketId = existing[0]?.id;
    }
    if (!ticketId) {
      c.skipped += 1;
      continue;
    }

    await client.query(
      `INSERT INTO support_messages
         (ticket_id, direction, body, author, origin, legacy_source_table, legacy_source_id, legacy_seq, created_at)
       VALUES ($1, 'inbound', $2, 'customer', 'import', 'event_inquiries', $3, 0, $4)
       ON CONFLICT (legacy_source_table, legacy_source_id, direction, legacy_seq)
         WHERE legacy_source_id IS NOT NULL DO NOTHING`,
      [ticketId, r.question, r.id, r.created_at],
    );

    if (r.answer && r.answer.trim().length > 0) {
      await client.query(
        `INSERT INTO support_messages
           (ticket_id, direction, body, author, origin, legacy_source_table, legacy_source_id, legacy_seq, created_at)
         VALUES ($1, 'outbound', $2, 'organizer', 'manual', 'event_inquiries', $3, 1, $4)
         ON CONFLICT (legacy_source_table, legacy_source_id, direction, legacy_seq)
           WHERE legacy_source_id IS NOT NULL DO NOTHING`,
        [ticketId, r.answer, r.id, r.updated_at],
      );
    }

    c.inserted += 1;
  }
}

interface ChatSessionRow {
  id: string;
  event_id: string;
  account_id: string;
  session_key: string;
  messages: unknown;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function parseChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is ChatMessage =>
      typeof m === "object" &&
      m !== null &&
      "role" in m &&
      "content" in m &&
      ((m as { role: unknown }).role === "user" || (m as { role: unknown }).role === "assistant") &&
      typeof (m as { content: unknown }).content === "string",
  );
}

async function backfillChatSessions(client: PoolClient, c: Counters): Promise<void> {
  // 종료 세션만 수렴(대화 이력 자체). escalation 승격은 신규 인입 경로가 담당(§2-3).
  const { rows } = await client.query<ChatSessionRow>(
    `SELECT pcs.id, pcs.event_id, ev.account_id, pcs.session_key, pcs.messages,
            pcs.created_at, pcs.updated_at
       FROM public_chat_sessions pcs
       JOIN events ev ON ev.id = pcs.event_id
      WHERE pcs.message_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM support_tickets st
           WHERE st.legacy_source_table = 'public_chat_sessions' AND st.legacy_source_id = pcs.id
        )`,
  );

  for (const r of rows) {
    const messages = parseChatMessages(r.messages);
    if (messages.length === 0) {
      c.skipped += 1;
      continue;
    }

    const customerKey = `chat:${r.session_key}`;

    if (!APPLY) {
      c.inserted += 1;
      continue;
    }

    const { rows: ticketRows } = await client.query<{ id: string }>(
      `INSERT INTO support_tickets
         (event_id, account_id, source, customer_key, status,
          legacy_source_table, legacy_source_id, last_message_at, created_at, updated_at)
       VALUES ($1, $2, 'chatbot', $3, 'resolved', 'public_chat_sessions', $4, $5, $6, $7)
       ON CONFLICT (legacy_source_table, legacy_source_id) WHERE legacy_source_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [r.event_id, r.account_id, customerKey, r.id, r.updated_at, r.created_at, r.updated_at],
    );

    let ticketId = ticketRows[0]?.id;
    if (!ticketId) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM support_tickets
          WHERE legacy_source_table = 'public_chat_sessions' AND legacy_source_id = $1 LIMIT 1`,
        [r.id],
      );
      ticketId = existing[0]?.id;
    }
    if (!ticketId) {
      c.skipped += 1;
      continue;
    }

    // JSONB 배열 각 원소 → 순서대로 inbound(user)/outbound(assistant) N행. legacy_seq=배열 인덱스.
    for (let seq = 0; seq < messages.length; seq += 1) {
      const m = messages[seq];
      const direction = m.role === "user" ? "inbound" : "outbound";
      const author = m.role === "user" ? "customer" : "agent";
      await client.query(
        `INSERT INTO support_messages
           (ticket_id, direction, body, author, origin, legacy_source_table, legacy_source_id, legacy_seq, created_at)
         VALUES ($1, $2, $3, $4, 'import', 'public_chat_sessions', $5, $6, $7)
         ON CONFLICT (legacy_source_table, legacy_source_id, direction, legacy_seq)
           WHERE legacy_source_id IS NOT NULL DO NOTHING`,
        [ticketId, direction, m.content, author, r.id, seq, r.created_at],
      );
    }

    c.inserted += 1;
  }
}

async function main(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  const totals: Record<string, Counters> = {
    inbound_emails: newCounters(),
    event_inquiries: newCounters(),
    public_chat_sessions: newCounters(),
  };

  try {
    await assertRequiredTables(client);
    console.log(
      APPLY ? "[apply] 수렴 백필을 실행합니다." : "[dry-run] 집계만 수행합니다(쓰기 없음). --apply 로 실제 수렴.",
    );
    if (APPLY && !FALLBACK_ACCOUNT_ID) {
      console.warn(
        "[warn] SUPPORT_FALLBACK_ACCOUNT_ID 미설정. event/assigned_to 미보유 미분류 메일은 스킵(보류)됩니다.",
      );
    }

    // 각 소스는 독립 트랜잭션 배치. 원본 read-only(변경 없음) — 원본 테이블 DROP/UPDATE 하지 않는다.
    await client.query("BEGIN");
    await backfillInboundEmails(client, totals.inbound_emails);
    await backfillEventInquiries(client, totals.event_inquiries);
    await backfillChatSessions(client, totals.public_chat_sessions);
    if (APPLY) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    for (const [table, c] of Object.entries(totals)) {
      console.log(`  ${table}: 티켓 ${c.inserted}건 ${APPLY ? "수렴" : "예상"}, 스킵 ${c.skipped}건`);
    }
    console.log("완료.");
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("백필 실패:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
