import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { requireFeature } from "@/lib/server/require-feature";
import { resendInvitation, revokeInvitation } from "@/lib/server/invitations";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { resendConflictMessage, v2ErrorCode } from "@/lib/v2/error-code";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string; invitationId: string };

const actionSchema = z.object({
  action: z.enum(["revoke", "resend"]),
});

/**
 * F2 초대권 라이프사이클 — 회수(revoke) / 재발송(resend).
 *  - revoke: 딥링크 nonce 증가(구 링크 무효) + 원장 revoked + 대기 큐 제거.
 *  - resend: 초대를 큐에 재적재(발권 완료된 것만). send_epoch +1 로 새 멱등키를 얻는다.
 *
 * ⚠️ 옛 주석은 "failed 초대를" 이라고 적었으나 틀렸다(2026-08-04 v2 배포본 :52 실측).
 *    v2 는 `revoked`(409) 와 발권 미완(`not_issued`)만 거른다 — **`failed` 조건은 없다.**
 *    `issued` 도 재적재되며, 실제로 그 경로로 멈춰 있던 초대권이 풀렸다.
 *
 * W5-ATTENDEE: 원장이 v2 정본이라 두 연산 모두 v2 왕복이다.
 * 🔴 v2 장애를 "찾을 수 없음(404)"·"재발송 불가(400)"로 위장하지 않는다 → 503.
 *    404 로 흘리면 주최자는 초대가 사라진 줄 알고 다시 대량 업로드를 돌린다.
 */
// 🔴 되돌릴 수 없는 쓰기다 — 역할 게이트를 붙인다 (2026-07-31).
//    읽기 라우트는 `organizer` 를 요구하는데 여기(발권·회수)만 무검사였다 —
//    권한 구조가 역전돼 있었다. 팀원(organizer)은 통과, 그 아래는 차단.
export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  const { eventId, invitationId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "ticket_issuance");
  if (featureBlock) return featureBlock;

  let body: z.infer<typeof actionSchema>;
  try {
    body = actionSchema.parse(await request.json());
  } catch {
    return errorResponse("action 은 revoke 또는 resend 여야 합니다", 400);
  }

  if (body.action === "revoke") {
    let ok: boolean;
    try {
      ok = await revokeInvitation({ accountId: session.accountId, eventId, invitationId });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) return errorResponse("회수할 초대를 찾을 수 없습니다", 404);
        // 🔴 **영구 거절을 재시도 문구로 내보내지 않는다.** v2 는 이미 입장한 초대권의
        //    회수를 409 로 거부한다(USED→CANCELLED 로 바꾸면 입장 이력이 있는 사람이
        //    "티켓 없음" 이 되고 재고가 한 번 더 줄어든다). 아래 503 문구로 떨어지면
        //    주최자는 "잠시 후 다시" 를 믿고 계속 누르지만 영원히 안 된다
        //    — 같은 얼굴의 사고를 오늘 두 번 봤다(만료 주문 502).
        if (v2ErrorCode(err) === "INVITATION_ALREADY_CHECKED_IN") {
          return errorResponse("이미 입장한 초대권은 회수할 수 없습니다", 409);
        }
        return errorResponse("초대 회수를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }
    if (!ok) return errorResponse("이미 회수된 초대입니다", 409);
    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "update",
      tableName: "invitations",
      recordId: invitationId,
      changes: { type: "invitation_revoke" },
      ipAddress: auditClientIp(request.headers),
    });
    return successResponse({ revoked: true });
  }

  // resend
  let result: { requeued: boolean; reason?: string };
  try {
    result = await resendInvitation({ accountId: session.accountId, eventId, invitationId });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("재발송할 초대를 찾을 수 없습니다", 404);
      // 🔴 409 는 두 가지다 — 회수됨 / 워커가 지금 발송 중. 뭉뚱그리면 멀쩡한 초대에
      //    "회수된 초대" 라고 표시해 주최자가 없는 문제를 쫓는다.
      if (err.status === 409)
        return errorResponse(resendConflictMessage(v2ErrorCode(err)), 409);
      return errorResponse("재발송을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  // 🔴 v2 가 준 사유를 그대로 올린다. 종전엔 어떤 이유로 막혔든 "발권 미완" 한 줄이라
  //    주최자가 조치를 고를 수 없었다(문자로 대체할 일인지, 기다릴 일인지 다르다).
  if (!result.requeued) {
    return errorResponse(
      result.reason ? `재발송할 수 없습니다 — ${result.reason}` : "재발송할 수 없습니다(발권 미완)",
      400,
    );
  }
  await logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "update",
    tableName: "invitations",
    recordId: invitationId,
    changes: { type: "invitation_resend" },
    ipAddress: auditClientIp(request.headers),
  });
  return successResponse({ requeued: true });
});
