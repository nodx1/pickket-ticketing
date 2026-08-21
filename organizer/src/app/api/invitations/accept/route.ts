import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import {
  v2Register,
  v2Login,
  V2AuthError,
  forwardSetCookies,
  extractClientContext,
} from "@/lib/auth/v2-proxy";
import { pushTeamMemberToV2 } from "@/lib/v2/organizer-sync";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

const acceptSchema = z.object({
  token: z.string().min(1, "초대 토큰이 누락되었습니다"),
  name: z.string().min(2, "이름은 2자 이상이어야 합니다"),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다"),
  phone: z
    .string()
    .regex(/^01[0-9]-?\d{3,4}-?\d{4}$/, "전화번호 형식이 올바르지 않습니다")
    .optional(),
});

/**
 * 초대 가입 — Phase 2 cutover 후 v2 register 와 결합.
 *
 * 1. invitations 토큰 검증 (만료/사용 여부)
 * 2. v2 register 호출 (비번 검증 + JWT 발급 + cookie set)
 * 3. go users stub 생성 + v2_user_id 매핑
 * 4. 기존 account 의 멤버로 추가 (event_organizers 가 아닌 user 테이블에 직접 join)
 * 5. v2 organizer_team_members 에 org-level 멤버십 (event_id=NULL, role=초대시 지정 role)
 */
export async function POST(request: Request) {
  try {
    const body = acceptSchema.parse(await request.json());
    const pool = getPool();

    // 1) 초대 검증
    const { rows: invs } = await pool.query<{
      id: string;
      account_id: string;
      email: string;
      role: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, account_id, email, role, status, expires_at
       FROM invitations
       WHERE token = $1
       LIMIT 1`,
      [body.token],
    );
    const invitation = invs[0];
    if (!invitation) {
      return errorResponse("유효하지 않은 초대 링크입니다", 400);
    }
    if (invitation.status !== "pending") {
      return errorResponse("이미 사용되었거나 취소된 초대입니다", 400);
    }
    if (new Date(invitation.expires_at) < new Date()) {
      return errorResponse("만료된 초대입니다", 400);
    }

    /**
     * 2) v2 계정 확보 — **신규 가입 또는 기존 계정 로그인**.
     *
     * 🔴 종전엔 신규 가입만 지원했다. 이미 피켓 회원인 사람(예: 예전에 소비자로 가입)이
     *    초대를 받으면 v2 가 `EMAIL_ALREADY_EXISTS` 로 거절하고, 화면은
     *    *"로그인 후 초대를 수락해주세요"* 라고 안내하는데 **그런 화면이 없었다.**
     *    막다른 길이었다 — 발주처 담당자가 기존 회원이면 대회 직전에 막힌다.
     *
     * ⟹ 가입이 중복으로 실패하면 **같은 비밀번호로 로그인**을 시도한다.
     *    로그인이 되면 본인 확인이 된 것이므로 그 계정을 팀원으로 붙인다.
     *    비밀번호가 틀리면 **가입도 로그인도 실패** — 남의 계정을 붙일 수 없다.
     *
     * ⚠️ 이 경로는 "초대 링크 + 그 계정의 비밀번호" 를 둘 다 아는 사람만 통과한다.
     *    링크만으로 남의 계정을 조직에 넣을 수는 없다.
     */
    let v2Result;
    let existingAccount = false;
    try {
      v2Result = await v2Register(
        {
          email: invitation.email,
          password: body.password,
          name: body.name,
          phone: body.phone,
          // 🔴 `false` 다 (2026-07-31). 종전엔 `true` 라 v2 가 팀원에게도
          //    **주최자 프로필을 만들어**, verify-token 이 멤버십보다 프로필을 먼저 보면
          //    팀원이 영원히 자기 테넌트로 잡혔다. v2 는 이제 멤버십을 먼저 보지만,
          //    애초에 팀원은 자기 조직이 없으므로 여기서도 승격시키지 않는다.
          is_organizer: false,
        },
        extractClientContext(request),
      );
    } catch (err: unknown) {
      const duplicate =
        err instanceof V2AuthError && (err.status === 409 || err.status === 400);
      if (!duplicate) {
        logger.error("초대 가입 — v2 register 실패", {
          email: invitation.email,
          error: err instanceof Error ? err.message : "unknown",
        });
        return errorResponse("가입 처리에 실패했습니다", 502);
      }
      try {
        v2Result = await v2Login(
          { email: invitation.email, password: body.password },
          extractClientContext(request),
        );
        existingAccount = true;
      } catch (loginErr: unknown) {
        logger.warn("초대 수락 — 기존 계정 로그인 실패(비밀번호 불일치 추정)", {
          email: invitation.email,
          error: loginErr instanceof Error ? loginErr.message : "unknown",
        });
        return errorResponse(
          "이미 가입된 이메일입니다. 기존 계정의 비밀번호를 입력해주세요.",
          401,
        );
      }
      if (!v2Result.v2UserId) {
        // MFA 등으로 토큰이 아직 없는 경우 — 조직 연결을 못 하므로 명시적으로 막는다.
        return errorResponse(
          "추가 인증이 필요한 계정입니다. 로그인 후 관리자에게 초대를 다시 요청해주세요.",
          409,
        );
      }
    }

    // 3) go user stub + 4) 초대 계정에 join
    const client = await pool.connect();
    let userId = "";
    try {
      await client.query("BEGIN");

      // go `users` 는 컷오버로 비어 있는 잔존 원장이다(0행). 계정 정본은 v2 다.
      // 기존 계정 경로에서 같은 이메일이 이미 있으면 충돌하므로 흡수한다.
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (
           id, account_id, email, name, role, phone,
           password_hash, v2_user_id,
           is_active, last_login_at, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, $5,
           NULL, $6,
           true, NOW(), NOW(), NOW()
         )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          invitation.account_id,
          invitation.email,
          body.name,
          invitation.role,
          body.phone ?? null,
          v2Result.v2UserId,
        ],
      );
      // ON CONFLICT 로 건너뛰면 rows 가 비어 있다 — v2 user id 를 앵커로 쓴다.
      userId = String(userResult.rows[0]?.id ?? v2Result.v2UserId);

      // 초대 사용 처리
      await client.query(
        `UPDATE invitations
         SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [invitation.id],
      );

      await client.query("COMMIT");
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      logger.error("초대 가입 — go DB 처리 실패 (v2 는 이미 생성됨)", {
        email: invitation.email,
        v2UserId: v2Result.v2UserId,
        error: err instanceof Error ? err.message : "unknown",
      });
      return errorResponse(ERR.SERVER, 500);
    } finally {
      client.release();
    }

    // 5) v2 organizer_team_members 에 org-level 멤버십 등록
    //
    // 🔴 종전엔 `SELECT v2_organizer_profile_id FROM accounts` 로 소유자를 찾았다.
    //    레벨2 컷오버로 go `accounts` 가 **0행**이 되면서 그 조회가 항상 비었고,
    //    `if (!profileId) return;` 으로 **조용히 빠져나가** 멤버십이 만들어지지 않았다.
    //    수락은 200 + 자동로그인까지 성공하므로 **장애로 보이지도 않았다.**
    //
    //    초대 행의 `account_id` 가 이미 조직 앵커(go 세션 accountId)다. v2 가
    //    `_resolve_organizer` 와 같은 규칙으로 해석하므로 그대로 넘긴다.
    //
    // ⚠️ 실패를 삼키지 않는다 — 멤버십이 없으면 로그인해도 행사가 안 보인다.
    //    가입 자체는 이미 커밋됐으므로 400 으로 되돌리지 않고, **응답에 표시**해
    //    운영이 손으로 붙일 수 있게 한다.
    let membershipLinked = false;
    try {
      // 🔴 시크릿 우선순위는 이 리포의 계약이다: `GO_WEBHOOK_SECRET` 우선,
      //    없으면 `V2_EVENT_SYNC_SECRET` 폴백 (messaging-ledger-client.ts:46 ·
      //    settlement/v2-fetcher · audit/outbox 전부 같은 형태).
      //    v2 는 `internal_sync` 전 라우트를 `settings.GO_WEBHOOK_SECRET` 로 검증한다.
      //
      // ⚠️ 종전 코드는 `V2_EVENT_SYNC_SECRET` **단독**이었다. 그 값만 없으면
      //    `if (!secret) return;` 으로 조용히 빠져나가 멤버십이 안 만들어졌다 —
      //    로컬 실호출로 잡았다(단위 테스트는 목이라 서명을 검증하지 않는다).
      const secret = process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
      const base = process.env.V2_INTERNAL_BASE_URL;
      if (!secret || !base) {
        throw new Error("GO_WEBHOOK_SECRET/V2_INTERNAL_BASE_URL 미설정");
      }
      const { default: nodeCrypto } = await import("node:crypto");
      const payload = {
        go_event_organizer_id: `invited-${userId}`,
        v2_event_id: null,
        // 소유자 앵커 — accounts 테이블을 보지 않는다.
        v2_organizer_ref: invitation.account_id,
        v2_user_id: v2Result.v2UserId,
        role:
          invitation.role === "owner" || invitation.role === "admin" ? "owner" : "manager",
        display_order: 0,
      };
      const ts = new Date().toISOString();
      const raw = JSON.stringify(payload);
      const sig = nodeCrypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
      const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/internal/organizer/teams/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pickket-Signature": sig,
          "X-Pickket-Timestamp": ts,
          "X-Pickket-Event": "organizer.team.import",
          "X-Pickket-Delivery-Id": nodeCrypto.randomUUID(),
        },
        body: raw,
      });
      if (!res.ok) {
        throw new Error(`v2 teams/import ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      membershipLinked = true;
    } catch (err: unknown) {
      logger.error("초대 가입 — 팀 멤버십 등록 실패(가입은 완료됨, 수동 연결 필요)", {
        email: invitation.email,
        accountId: invitation.account_id,
        v2UserId: v2Result.v2UserId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }

    // pushTeamMemberToV2 는 event_organizers row 가 있을 때만 동작
    // 초대 사용자는 event_organizers 와 무관 (account 멤버십). 위 블록에서 직접 처리.
    void pushTeamMemberToV2; // 사용 안 함 표시 (lint)

    // v2 cookie forward — 자동 로그인
    const response = successResponse({
      accepted: true,
      // 🔴 false 면 로그인해도 행사가 안 보인다 — 화면이 이걸 알려야 한다.
      membershipLinked,
      existingAccount,
      id: userId,
      accountId: invitation.account_id,
      email: invitation.email,
      role: invitation.role,
    });
    forwardSetCookies(response, v2Result.setCookieHeaders);
    return response;
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    logger.error("[invitations/accept] 처리 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return errorResponse(ERR.SERVER, 500);
  }
}
