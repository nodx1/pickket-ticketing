/**
 * 팀 멤버 목록·초대.
 *
 * ## 원장 (2026-07-31 복구)
 * · **멤버**: v2 `organizer_team_members` (정본). 종전엔 go `users` 를 봤는데
 *   레벨2 컷오버로 그 테이블이 비면서 **에러 없이 "팀원 0명"** 이 나왔다 —
 *   장애로 보이지 않는 파손이었다.
 * · **초대장**: go `invitations` (그대로). 아직 v2 에 대응 원장이 없고,
 *   수락 시점에 v2 멤버십으로 승격된다.
 *
 * 🔴 v2 조회가 실패하면 **빈 목록으로 위장하지 않는다.** 같은 실수를 반복하지 않기 위해
 *    503 으로 표면화한다 — "팀원이 없다" 와 "못 불러왔다" 는 다른 사실이다.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/notification/email";
import { listTeamMembers, logTeamFailure } from "@/lib/v2/team-client";

const schema = z.object({
  email: z.email("올바른 이메일을 입력해주세요"),
  role: z.enum(["admin", "organizer", "staff", "check_in"]),
  name: z.string().min(2, "이름을 입력해주세요"),
  invitationId: z.string().uuid().optional(),
});

export const GET = withRole("admin", async (_request, { session }) => {
  const pool = getPool();

  // 초대장은 아직 go 원장이다(수락 시 v2 멤버십으로 승격된다).
  const invitationsResult = await pool.query(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        expires_at AS "expiresAt",
        created_at AS "createdAt"
      FROM invitations
      WHERE account_id = $1
      ORDER BY created_at DESC
    `,
    [session.accountId],
  );

  // 🔴 멤버 정본은 v2 다. 실패를 빈 목록으로 위장하지 않는다.
  let members;
  try {
    members = (await listTeamMembers(session.accountId)).members;
  } catch (err: unknown) {
    logTeamFailure("목록 조회", err);
    return errorResponse("팀 멤버를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
  }

  return successResponse({ members, invitations: invitationsResult.rows });
});

export const POST = withRole("admin", async (request, { session }) => {
  try {
    const body = schema.parse(await request.json());
    const pool = getPool();
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    if (body.invitationId) {
      await pool.query(
        `
          UPDATE invitations
          SET
            name = $3,
            email = $4,
            role = $5,
            invited_by_user_id = $6,
            token = $7,
            status = 'pending',
            expires_at = $8,
            updated_at = NOW()
          WHERE id = $1 AND account_id = $2
        `,
        [body.invitationId, session.accountId, body.name, body.email, body.role, session.id, token, expiresAt],
      );
    } else {
      await pool.query(
        `
          INSERT INTO invitations (
            id, account_id, name, email, role, invited_by_user_id, token, status, expires_at, accepted_at, created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', $7, NULL, NOW(), NOW()
          )
        `,
        [session.accountId, body.name, body.email, body.role, session.id, token, expiresAt],
      );
    }

    // 메일 실패가 초대 자체를 400 으로 만들면 안 된다 — 초대 행은 이미 커밋됐고
    // 재시도할 때마다 고아 토큰만 쌓인다. 실패는 기록하고 발송 여부를 응답에 노출.
    let mailSent = true;
    try {
      await sendEmail({
        to: body.email,
        subject: "[PICKKET.GO] 팀 멤버 초대",
        bodyHtml: `<p>${body.name}님을 PICKKET.GO 팀 멤버로 초대했습니다.</p><p><a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/accept-invitation?token=${token}">초대 수락하기</a></p>`,
        bodyText: `${body.name}님을 PICKKET.GO 팀 멤버로 초대했습니다. ${process.env.NEXT_PUBLIC_APP_URL ?? ""}/accept-invitation?token=${token}`,
      });
    } catch (mailErr: unknown) {
      mailSent = false;
      logger.error("팀 멤버 초대 메일 발송 실패", {
        source: "account-members",
        error: mailErr instanceof Error ? mailErr.message : "알 수 없는 오류",
      });
    }

    /**
     * 🔴 초대 **링크를 응답에 담는다** (2026-07-31).
     *
     * 지금 `pickket.kr` 은 발신 메일이 설정되지 않아 `mailSent:false` 가 정상이다.
     * 링크를 안 주면 주최자는 초대장을 만들고도 **전달할 방법이 없다** —
     * 실제로 그 상태로 초대장 1건이 떠 있었다(아무도 못 받는 주소로).
     *
     * ⚠️ 이 링크는 **수락 자격 그 자체**다. 응답은 `withRole("admin")` 뒤에 있고
     *    화면에서만 표시한다. 로그·감사기록에 남기지 말 것.
     */
    const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/accept-invitation?token=${token}`;
    return successResponse(
      { invited: true, mailSent, acceptUrl, id: body.invitationId ?? "created" },
      201,
    );
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("팀 멤버를 초대하지 못했습니다", 400);
  }
});
