/**
 * 인바운드 이메일 웹훅 — 수신 메일을 v2 수신함 원장에 적재(레벨2 컷오버 W5-MSG).
 *
 * 🔴 멱등: provider 웹훅은 재시도한다. 같은 메일이 두 통으로 보이지 않도록 **내용에서 유도한
 *   안정 키**(발신자+제목+본문 해시)를 Idempotency-Key 로 보낸다. randomUUID 는 멱등이 아니다.
 *
 * 🔴 fail-closed: 적재 실패 시 5xx 를 돌려 provider 가 재시도하게 한다. 200 을 주면 메일이
 *   조용히 사라진다(주최자는 문의를 영영 못 본다).
 *
 * ⚠️ `attendees` 조회(발신자 → 이벤트 매칭)는 **참석자 트랙 소유** 테이블이다. 여기서는
 *   account_id 를 함께 읽어 v2 로 전달하는 것 외에는 손대지 않는다(테넌트 경계 강화용).
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { ingestInboundEmail } from "@/lib/v2/messaging-ledger-client";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-webhook-secret");
  if (secret !== process.env.INBOUND_EMAIL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let fromEmail = "";
  let fromName = "";
  let subject = "";
  let bodyText = "";
  let bodyHtml = "";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    fromEmail = typeof body.from === "string" ? body.from : typeof body.sender === "string" ? body.sender : "";
    fromName = typeof body.from_name === "string" ? body.from_name : "";
    subject = typeof body.subject === "string" ? body.subject : "";
    bodyText = typeof body.text === "string" ? body.text : typeof body.plain === "string" ? body.plain : "";
    bodyHtml = typeof body.html === "string" ? body.html : "";
  } catch {
    return NextResponse.json({ error: "요청 본문을 해석하지 못했습니다" }, { status: 400 });
  }

  if (!fromEmail) {
    return NextResponse.json({ error: "발신자 이메일이 없습니다" }, { status: 400 });
  }

  // 발신자를 참석자 명부로 매칭해 이벤트/계정을 유추(매칭 실패는 null — 원본 동작 보존).
  let eventId: string | null = null;
  let accountId: string | null = null;
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ event_id: string; account_id: string }>(
      `SELECT a.event_id, a.account_id FROM attendees a WHERE LOWER(a.email) = LOWER($1) LIMIT 1`,
      [fromEmail],
    );
    eventId = rows[0]?.event_id ?? null;
    accountId = rows[0]?.account_id ?? null;
  } catch (err: unknown) {
    // 매칭 실패는 치명적이지 않다 — 미분류 수신함으로 적재하고 계속 진행한다.
    logger.warn("인바운드 이메일 이벤트 매칭 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  const idempotencyKey = createHash("sha256")
    .update([fromEmail, subject, bodyText, bodyHtml].join("\n"))
    .digest("hex");

  try {
    await ingestInboundEmail(
      {
        accountId,
        eventId,
        fromEmail,
        fromName: fromName || null,
        subject: subject || null,
        bodyText: bodyText || null,
        bodyHtml: bodyHtml || null,
      },
      idempotencyKey,
    );
  } catch (err: unknown) {
    // 🔴 200 을 주면 provider 가 재시도하지 않아 메일이 유실된다 → 502 로 재시도를 유도.
    logger.error("인바운드 이메일 적재 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "수신함 적재에 실패했습니다" }, { status: 502 });
  }

  return NextResponse.json({ received: true });
}
