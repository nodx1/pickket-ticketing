import { z } from "zod";
import { listResponse, errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { generateOrganizerSlug } from "@/lib/organizer-slug";
import {
  createEventHost,
  listEventHosts,
  V2CommerceError,
  type EventHost,
} from "@/lib/v2/commerce-client";

/**
 * ── 레벨2 컷오버 W3-OPS — go read/write 잔존 사유 ──
 * go `organizers`(주최자 프로필: 이름·로고·연락처·공개여부)는 v2 에 대응 테이블이 없다.
 * v2 의 `organizer_ref` 는 go **account_id** 를 가리키는 참조값일 뿐 프로필 저장소가 아니다
 * (`commerce-client.goAccountRef`). 즉 옮길 곳이 아직 없다 → v2 스키마 신설이 선행 조건.
 * 계정당 N개 주최자 프로필이라 account_id 경계는 아래 쿼리들이 직접 강제한다.
 */
// slug 는 사용자 입력이 아니라 이름에서 자동 생성(내부 식별자). 폼에서 제거됨.
const organizerSchema = z.object({
  name: z.string().min(2, "주최자 이름은 2자 이상이어야 합니다"),
  description: z.string().optional(),
  email: z.email("올바른 이메일 형식을 입력해주세요").or(z.literal("")).optional(),
  phone: z.string().optional(),
  logoUrl: z.string().optional(),
  // 방향2 A: 연락처(email/phone) 소비자 공개 여부. 이름·로고는 항상 공개.
  contactPublic: z.boolean().optional(),
});

/** v2 `event_hosts` 행 → 옛 go `organizers` 응답 shape(프론트 계약 불변). */
function toGoRow(host: EventHost) {
  return {
    id: host.host_id,
    name: host.name,
    slug: host.slug,
    description: host.description,
    email: host.email,
    phone: host.phone,
    logoUrl: host.logo_url,
    contactPublic: host.contact_public,
    isPublished: host.is_published,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
  };
}

/**
 * 주최자 카탈로그 목록 (레벨2 컷오버 W2-EVT — go `organizers` 테이블 → v2 `event_hosts`).
 *
 * 🔴 fail-closed: v2 장애를 빈 목록으로 위장하지 않는다(주최자가 "내 주최자가 다 사라졌다"고
 *    오인한 뒤 중복 생성하면 slug 충돌·표기 중복이 남는다). → 503.
 */
export const GET = withRole("organizer", async (_request, { session }) => {
  try {
    const { hosts } = await listEventHosts(session.accountId);
    const rows = hosts.map(toGoRow);
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "커머스 서버에 연결할 수 없어 주최자 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
});

export const POST = withRole("organizer", async (request, { session }) => {
  let body: z.infer<typeof organizerSchema>;
  try {
    body = organizerSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // slug 는 계정 스코프 유니크 — 기존 목록을 근거로 생성한다(옛 go 동작 동일).
  let slug: string;
  try {
    slug = await generateOrganizerSlug(session.accountId, body.name);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "커머스 서버에 연결할 수 없어 주최자를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  try {
    const host = await createEventHost(session.accountId, {
      name: body.name,
      slug,
      description: body.description ?? null,
      email: body.email || null,
      phone: body.phone || null,
      logo_url: body.logoUrl || null,
      contact_public: body.contactPublic ?? false,
      is_published: false,
    });
    return successResponse(toGoRow(host), 201);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 409) {
        return errorResponse("이미 같은 이름의 주최자가 있습니다. 이름을 변경해주세요.", 409);
      }
      return errorResponse(
        "주최자 생성 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
});
