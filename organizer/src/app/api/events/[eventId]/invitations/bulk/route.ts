import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { requireFeature } from "@/lib/server/require-feature";
import { bulkIssueInvitations } from "@/lib/server/invitations";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string };

const bulkSchema = z.object({
  recipients: z
    .array(
      z.object({
        name: z.string().min(1, "이름은 필수입니다"),
        // 서버 방어선: 숫자만 정규화 후 KR 휴대폰 형식 판정(파싱 검증 우회 차단).
        phone: z
          .string()
          .min(1, "전화번호는 필수입니다")
          .transform((v) => v.replace(/\D/g, ""))
          .refine((v) => /^01[0-9]\d{7,8}$/.test(v), "휴대폰 번호 형식 오류(예: 01012345678)"),
        // F1 daypass 지정일(선택). YYYY-MM-DD.
        admissionDay: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다")
          .optional(),
        // F1/F5 입장 규칙(선택). 초대권 화면 "입장 가능 일자" 표기 스냅샷.
        admissionMode: z.enum(["single", "daypass", "allpass"]).optional(),
      }),
    )
    .min(1, "수신자를 1명 이상 입력해주세요")
    .max(10_000, "한 번에 최대 10,000명까지 처리할 수 있습니다"),
  /**
   * 배치 멱등 **명시 해제** — "이미 처리한 명단입니다" 를 무시하고 다시 발급한다.
   *
   * 🔴 이 불리언 하나가 클라이언트가 보낼 수 있는 전부다. 지문·Redis 키는 서버가
   *    명단에서 재계산한다 — 키 문자열을 받으면 타 행사 멱등까지 지울 수 있다.
   * ⚠️ 켜면 같은 사람에게 초대권이 **한 장 더** 나간다. 화면은 반드시 명시적으로
   *    확인을 받아야 한다(기본값 false).
   */
  force: z.boolean().optional(),
});

/**
 * F2 초대권 대량 배포 — 명단 → comp 발권 → 알림톡 발송 큐 적재(비동기).
 *
 * 이 라우트는 동기 발송 왕복을 하지 않는다: 각 수신자에게 comp 티켓을 발권하고
 * invitation_dispatch 큐에 적재만 한다. 실제 알림톡 발송은 cron(/api/cron/dispatch-invitations)이
 * 배치로 처리한다(수천 건 타임아웃·이중발송 방지).
 *
 * 🔴 중복제거 없음(2026-07-30, 1인 최대 5장 요건). 같은 번호를 여러 줄 넣으면 그만큼 발급한다.
 *    종전엔 `deduped`(배치 내 중복) · `skipped`(이미 발권된 phone 재업로드)로 접었는데,
 *    그 접힘이 다장 발급의 실제 관문이었다. 응답 필드도 그에 맞춰 바뀌었다:
 *      issued  발급된 **장수** · atLimit 그 번호가 상한이라 못 준 줄 수
 *      invalid 번호 없음·형식 불량 · failed 예약·발권 실패
 *    ⚠️ 재업로드 방어는 이제 **배치 멱등키**가 맡는다(같은 명단 재실행 → 결과 재사용).
 */
// 🔴 되돌릴 수 없는 쓰기다 — 역할 게이트를 붙인다 (2026-07-31).
//    읽기 라우트는 `organizer` 를 요구하는데 여기(발권·회수)만 무검사였다 —
//    권한 구조가 역전돼 있었다. 팀원(organizer)은 통과, 그 아래는 차단.
export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "ticket_issuance");
  if (featureBlock) return featureBlock;

  let body: z.infer<typeof bulkSchema>;
  try {
    body = bulkSchema.parse(await request.json());
  } catch (err: unknown) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message ?? "입력이 올바르지 않습니다" : "입력이 올바르지 않습니다";
    return errorResponse(message, 400);
  }

  const result = await bulkIssueInvitations({
    accountId: session.accountId,
    eventId,
    recipients: body.recipients,
    force: body.force,
  });

  await logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "create",
    tableName: "event_invitations",
    recordId: eventId,
    changes: {
      type: "bulk_invitation",
      requested: result.requested,
      issued: result.issued,
      atLimit: result.atLimit,
      invalid: result.invalid,
      failed: result.failed,
      // 🔴 멱등을 푼 사실은 반드시 남긴다 — "누가 언제 어느 명단의 재발송 방어를
      //    껐는가" 는 이중발송 사고가 났을 때 유일한 단서다. 지문까지 함께 남겨야
      //    어느 명단이었는지 특정할 수 있다.
      ...(body.force ? { forcedResend: true, batchFingerprint: result.batchFingerprint } : {}),
    },
    ipAddress: auditClientIp(request.headers),
  });

  return successResponse(result);
});
