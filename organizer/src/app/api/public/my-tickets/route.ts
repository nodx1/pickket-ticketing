/**
 * /api/public/my-tickets — 구매 이메일+전화로 내 티켓 조회(비로그인).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `attendees JOIN events` → v2 `POST /internal/public/ticket-lookup`.
 * 상품명(product_name)도 같은 응답에서 오므로 예전의 티켓 단건 팬아웃
 * (`enrichTicketProductNames`, 최대 50회 왕복)이 통째로 사라졌다.
 *
 * ⚠️ 매칭 기준 변화: go 는 **참석자** 연락처, v2 는 **주문 구매자** 연락처로 매칭한다
 *    (v2 는 티켓별 참석자 연락처를 보관하지 않는다). 단건 구매는 동일.
 *
 * 실패 계약: v2 불가 시 **503**. 빈 목록으로 위장하면 "내 티켓이 사라졌다"가 된다.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/notification/email";
import {
  createMagicLinkToken,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";
import {
  V2CommerceError,
  lookupPublicTicketsV2,
  type PublicTicketLookupRow,
} from "@/lib/v2/commerce-client";

const schema = z.object({
  email: z.email("올바른 이메일 형식을 입력해주세요"),
  phone: z.string().min(10, "전화번호를 입력해주세요"),
});

interface TicketGroup {
  eventTitle: string;
  startsAt: string | null;
  venueName: string | null;
  tickets: Array<{
    ticketNumber: string | null;
    name: string | null;
    status: string;
    productName: string | null;
  }>;
}

/** 한 사람이 조회할 수 있는 티켓 수 상한(v2 도 500 으로 clamp). */
const LOOKUP_LIMIT = 100;

/** email+phone 으로 티켓을 조회해 이벤트별로 그룹핑한다. */
async function fetchTickets(
  email: string,
  phone: string,
): Promise<{ rows: PublicTicketLookupRow[]; grouped: TicketGroup[] }> {
  const { tickets } = await lookupPublicTicketsV2({ email, phone, limit: LOOKUP_LIMIT });

  const grouped = tickets.reduce<Record<string, TicketGroup>>((acc, row) => {
    // go 도 event **title** 로 묶었다(동명 이벤트는 합쳐진다) — 동작 동일성 유지.
    const key = row.event_title ?? "";
    if (!acc[key]) {
      acc[key] = {
        eventTitle: row.event_title ?? "",
        startsAt: row.event_starts_at,
        venueName: row.event_venue,
        tickets: [],
      };
    }
    acc[key].tickets.push({
      ticketNumber: row.ticket_number,
      name: row.name,
      status: row.status,
      productName: row.product_name,
    });
    return acc;
  }, {});

  return { rows: tickets, grouped: Object.values(grouped) };
}

/**
 * POST — 조회 요청. email+phone 지식만으로 쿠키/티켓을 즉시 내주지 않고, 구매 이메일로
 * 매직링크를 보낸다(이메일 수신함 소유증명). 응답은 티켓 존재 여부와 무관하게 동일(열거 방지). (감사 P1-7)
 */
async function requestLookupHandler(request: Request) {
  try {
    const body = schema.parse(await request.json());

    let rows: PublicTicketLookupRow[];
    try {
      ({ rows } = await fetchTickets(body.email, body.phone));
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        // 🔴 "메일 보냈습니다"로 위장하면 사용자는 오지 않는 메일을 영원히 기다린다.
        return errorResponse(
          "티켓 조회 서비스에 일시적인 문제가 있습니다. 잠시 후 다시 시도해주세요.",
          503,
        );
      }
      throw err;
    }

    if (rows.length > 0) {
      const token = createMagicLinkToken({ email: body.email, phone: body.phone });
      const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://go.pickket.kr").replace(/\/$/, "");
      const link = `${base}/api/public/my-tickets/verify?token=${encodeURIComponent(token)}`;
      try {
        await sendEmail({
          to: body.email,
          subject: "[PICKKET.GO] 내 티켓 조회 링크",
          bodyText: `아래 링크로 15분 내에 티켓을 조회하세요.\n${link}\n\n요청하지 않았다면 이 메일을 무시하세요.`,
          bodyHtml: `<p>아래 버튼으로 <b>15분 내</b>에 티켓을 조회하세요.</p>
<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#6C5CE7;color:#fff;border-radius:100px;text-decoration:none">내 티켓 조회</a></p>
<p style="color:#888;font-size:12px">요청하지 않았다면 이 메일을 무시하세요.</p>`,
        });
      } catch (mailErr) {
        logger.error("[my-tickets] 매직링크 메일 발송 실패", {
          error: mailErr instanceof Error ? mailErr.message : String(mailErr),
        });
      }
    }

    // 열거 방지: 티켓 존재 여부와 무관하게 동일 응답.
    return successResponse({
      emailSent: true,
      message: "입력하신 이메일로 조회 링크를 보냈습니다. 메일함을 확인해주세요.",
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

/**
 * GET — 매직링크 검증 후 발급된 PUBLIC_LOOKUP_COOKIE 로 실제 티켓 목록을 반환한다.
 * 쿠키가 없거나 만료면 401 → 프론트가 조회 폼으로 유도.
 */
export async function GET() {
  const cookieStore = await cookies();
  const lookup = verifyPublicLookupToken(cookieStore.get(PUBLIC_LOOKUP_COOKIE)?.value);
  if (!lookup) {
    return errorResponse("조회 세션이 없습니다. 이메일로 조회 링크를 다시 요청해주세요.", 401);
  }
  try {
    const { grouped } = await fetchTickets(lookup.email, lookup.phone);
    return successResponse(grouped);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "티켓 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "public:my-tickets",
})(requestLookupHandler);
