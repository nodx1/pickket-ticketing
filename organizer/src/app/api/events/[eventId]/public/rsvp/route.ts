/**
 * POST /api/events/[eventId]/public/rsvp — 공개 참석 등록(RSVP).
 *
 * ── 레벨2 컷오버 W2-PUB / W4-ORD ──
 * ✅ go `SELECT account_id, rsvp_enabled, rsvp_config FROM events WHERE id=$1 AND status='live'`
 *    → v2 이벤트 상세 read + 동일 상태 게이트(live).
 * ✅ W4-ORD: 참석 상한·중복확인의 go `attendees` 조회 → v2 티켓 집계/조회.
 *    (v2 `_attendee_count` = `tickets WHERE status <> cancelled` — 옛 go 조건과 동치)
 * 🔴 **미전환**: `ensureRsvpProduct(pool, ...)` — `lib/server/rsvp-product.ts`(타 트랙 소유)가
 *    pool 을 인자로 요구한다. 시그니처를 바꾸는 것은 이 트랙 범위 밖이다.
 */
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createOrder, V2CommerceError } from "@/lib/server/orders";
import { ensureRsvpProduct } from "@/lib/server/rsvp-product";
import { getEventLive, listAttendees } from "@/lib/v2/commerce-client";
import { PUBLIC_LIVE_STATUSES, resolvePublicEventById } from "@/lib/v2/public-event";

const rsvpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  let body: z.infer<typeof rsvpSchema>;
  try {
    body = rsvpSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? "입력값을 확인해주세요" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "요청 본문을 파싱할 수 없습니다" }, { status: 400 });
  }

  const normalizedEmail = body.email.toLowerCase();
  const pool = getPool();

  // ── 1) 이벤트/RSVP 게이트 (v2 read). 접수 자체는 아래 createOrder(v2 SSOT) 가 원자처리. ──
  const resolved = await resolvePublicEventById(eventId, PUBLIC_LIVE_STATUSES);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const event = resolved.event;
  if (!event.rsvp_enabled) {
    return NextResponse.json({ error: "이 이벤트는 RSVP를 지원하지 않습니다" }, { status: 400 });
  }

  const config = (event.rsvp_config ?? {}) as {
    maxAttendees?: number;
    requireApproval?: boolean;
  };
  const accountId = event.go_account_id;
  if (!accountId) {
    // 소유 테넌트를 모르면 주문을 어느 계정으로 키잉할지 알 수 없다 — 조용히 진행 금지.
    return NextResponse.json({ error: "참석 등록을 처리할 수 없습니다" }, { status: 409 });
  }

  // ── W4-ORD: 상한·중복 판정을 v2 티켓 정본으로. 🔴 두 조회 모두 **fail-closed** 다 —
  //    실패를 "0명·중복없음"으로 흘리면 상한을 넘겨 받아버리거나(정원 초과) 중복 접수가 뚫린다.
  //    실패는 503(재시도 가능)으로 끊는다.
  //
  //    참석 상한 — rsvp_config.maxAttendees. v2 `total_attendees` = `tickets WHERE status <>
  //    cancelled` 로 옛 go 조건(`attendees.status != 'cancelled'`)과 정확히 같은 집합이다.
  if (config.maxAttendees) {
    let attendeeCount: number;
    try {
      attendeeCount = (await getEventLive(eventId)).total_attendees;
    } catch {
      return NextResponse.json({ error: "참석 등록을 잠시 후 다시 시도해주세요." }, { status: 503 });
    }
    if (attendeeCount >= config.maxAttendees) {
      return NextResponse.json({ error: "참석 인원이 마감되었습니다" }, { status: 400 });
    }
  }

  // 중복 접수 방지(동일 이메일, 취소 제외).
  //   v2 `q` 는 buyer_email ILIKE 부분일치라 후보를 좁히는 용도 — 최종 판정은 **정확 일치**로 한다
  //   (부분일치만 믿으면 `a@x.com` 접수자가 `aa@x.com` 접수를 막는다).
  //   ⚠️ 이 검사는 UX 안내용 2차 방어선이다. 실제 중복 차단의 정본은 아래 createOrder 의
  //      `idempotencyToken = rsvp:{eventId}:{email}` — 동시 2회 요청도 v2 가 한 주문으로 흡수한다.
  try {
    const dup = await listAttendees(eventId, { q: normalizedEmail, limit: 500 });
    const alreadyRegistered = dup.attendees.some(
      (a) => (a.email ?? "").trim().toLowerCase() === normalizedEmail && a.status.toLowerCase() !== "cancelled",
    );
    if (alreadyRegistered) {
      return NextResponse.json({ error: "이미 참석 등록하셨습니다" }, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "참석 등록을 잠시 후 다시 시도해주세요." }, { status: 503 });
  }

  // ── 2) RSVP 전용 0원 상품 보장(v2 tier 앵커) — createOrder 가 참조할 tier. ──
  let rsvpProduct: { productId: string } | null;
  try {
    rsvpProduct = await ensureRsvpProduct(pool, eventId, accountId);
  } catch {
    return NextResponse.json({ error: "참석 등록에 실패했습니다" }, { status: 500 });
  }
  if (!rsvpProduct) {
    // v2 앵커 미준비/동기화 일시 실패 — 재시도 가능.
    return NextResponse.json(
      { error: "참석 등록을 잠시 후 다시 시도해주세요." },
      { status: 503 },
    );
  }

  // 승인제(requireApproval)면 대기(pending) 주문 — 매출·결제확정 없이 참석자만 pending 으로 키잉.
  const requireApproval = config.requireApproval === true;

  // ── 3) 표준 createOrder(v2 write-through)로 0원 주문 생성 → v2 SSOT + 티켓·참석자 정합. ──
  try {
    await createOrder({
      accountId,
      eventId,
      buyerName: body.name,
      buyerEmail: normalizedEmail,
      buyerPhone: body.phone,
      items: [{ productId: rsvpProduct.productId, quantity: 1 }],
      paymentMethod: "offline",
      status: requireApproval ? "pending" : "completed",
      paymentStatus: requireApproval ? "pending" : "paid",
      totalAmountOverride: 0,
      paidAmount: 0,
      source: "direct",
      idempotencyToken: `rsvp:${eventId}:${normalizedEmail}`,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { error: "참석 등록을 잠시 후 다시 시도해주세요." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "참석 등록에 실패했습니다" }, { status: 500 });
  }

  const status = requireApproval ? "pending" : "confirmed";
  return NextResponse.json({
    data: {
      status,
      message: status === "confirmed"
        ? "참석이 확인되었습니다!"
        : "참석 신청이 접수되었습니다. 승인 후 확인됩니다.",
    },
  });
}
