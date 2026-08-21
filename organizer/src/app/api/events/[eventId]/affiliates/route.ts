import { z } from "zod";
import crypto from "node:crypto";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
// ── 레벨2 컷오버 W5-SUPPORT: go `affiliates` 앵커 write 제거(read 는 이미 v2). ──
// go 행은 v2 canonical affiliate 의 미러/앵커였을 뿐이라 통째로 걷어낸다.
import { createAffiliate, listAffiliates, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

const schema = z.object({
  name: z.string().min(2, "이름을 입력해주세요"),
  code: z.string().min(2, "코드를 입력해주세요").regex(/^[A-Z0-9_-]+$/, "코드는 영문 대문자, 숫자, -, _만 사용할 수 있습니다"),
  commissionRate: z.number().min(0).max(100),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  // ── 레벨2 read-flip: 제휴 목록/전환집계 정본 = v2. go 조인 제거. ──
  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회도 제거. 소유격리(옛 `AND account_id`)는
  //    v2 `organizer_ref` 가 강제한다(미소유/부재→null→기존과 동일하게 409).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    // v2 장애를 "미동기화(409)"로 오인하지 않는다(아래 catch 는 V2CommerceError 전용).
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    return errorResponse("이벤트가 아직 커머스에 동기화되지 않았습니다", 409);
  }

  try {
    const v2 = await listAffiliates(v2EventId);
    // id = go affiliate id(external_ref) — 상세/수정/삭제 라우트가 go id 기준이라 일관 유지.
    const rows = v2.affiliates.map((a) => ({
      id: a.external_ref ?? a.affiliate_id,
      name: a.name,
      code: a.code,
      commissionRate: a.commission_rate,
      status: a.status,
      conversionCount: a.conversion_count,
      commissionTotal: a.commission_total,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("제휴 목록을 불러오지 못했습니다", 502);
    }
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    // ── 부모 이벤트 소유 검증 + v2 앵커 — 자식 affiliate 는 v2 event 로 주소지정. ──
    // ── 레벨2 컷오버 T2-EVT: go events 조회 제거. 옛 `AND account_id` 테넌트 경계는
    //    v2 `organizer_ref` 가 강제한다(미소유/부재 → null → 기존과 동일하게 409).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("이벤트가 아직 커머스에 동기화되지 않았습니다", 409);
    }

    const affiliateId = crypto.randomUUID();

    // ── W5-SUPPORT: go 사전 중복검사(SELECT … WHERE code) + go INSERT 미러를 제거. ──
    // 🔴 사전검사를 v2 목록조회로 옮기면 **TOCTOU** 가 생기고, 배치 upsert(`upsertAffiliates`)는
    //    code 로 매칭해 **덮어쓰기**라 경합 시 남의 제휴 정의(이름·수수료율)를 가로챈다.
    //    그래서 생성 전용 엔드포인트를 쓴다 — v2 `uq_affiliates_event_code` 유니크 제약이
    //    중복을 **원자적으로** 409 로 끊는다(사전검사 자체가 불필요해졌다).
    // go 미러가 사라졌으므로 보상(compensating) 트랜잭션도 필요 없다 — 단일 write 다.
    try {
      await createAffiliate(v2EventId, {
        organizer_ref: session.accountId,
        external_ref: affiliateId,
        name: body.name,
        code: body.code,
        commission_rate: body.commissionRate, // percent 0–100
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 409) {
          return errorResponse("이미 사용 중인 어필리에이트 코드입니다", 409);
        }
        if (err.status === 404) {
          return errorResponse("이벤트가 아직 커머스에 동기화되지 않았습니다", 409);
        }
        return errorResponse(
          "어필리에이트 생성 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
          502,
        );
      }
      throw err;
    }

    return successResponse({ id: affiliateId }, 201);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    // 광범위 catch 가 400 으로 뭉개므로 v2 장애만 명시 분기 — "입력값 문제"로 오인하면
    // 주최자가 무한 재입력하게 된다(재시도 가능 신호 503 으로 구분).
    if (error instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse("어필리에이트를 생성하지 못했습니다", 400);
  }
});
