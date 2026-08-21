import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";
import { loadCatalog } from "@/lib/v2/tier-catalog";
import { deleteWaitlistEntry, transitionWaitlistEntry } from "@/lib/v2/waitlist-client";
import { sendWaitlistOffer, type WaitlistOfferContext } from "@/lib/waitlist/offer";

type Params = { eventId: string; entryId: string };

const schema = z.object({
  status: z.enum(["waiting", "offered", "converted", "cancelled", "expired"]),
});

/**
 * 대기열 상태 전이 — v2 정본에 위임(원자 CAS·offered_at/expires_at/token_version 은 v2 소유).
 * 전이 성공 후, offered 이면 go-local 컨텍스트(이벤트/상품 메타)로 제안 이메일을 발송한다.
 *
 * 트랜잭션 경계: v2 가 상태를 커밋(영속)한 뒤에만 외부 발송을 수행한다(외부호출 후 crash 여도
 * 상태 정합 유지). 발송 실패는 상태를 되돌리지 않는다(best-effort, 주최자 재제안 가능).
 */
export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    let entry;
    try {
      // 이벤트 경계(P1): account_id 뿐 아니라 URL 의 eventId 를 v2 계약에 포함 → v2 WHERE 에서
      //   같은 account 의 다른 이벤트 entry 조작(크로스이벤트 IDOR)을 차단한다.
      entry = await transitionWaitlistEntry(params.entryId, {
        account_id: session.accountId,
        event_id: params.eventId,
        status: body.status,
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
        if (err.status === 409) {
          return errorResponse("대기자 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해주세요", 409);
        }
        if (err.status === 400) return errorResponse(ERR.INVALID_INPUT, 400);
        logger.warn("대기열 상태 전이 v2 실패", { entryId: params.entryId, status: err.status });
        return errorResponse("대기열 상태 변경에 실패했습니다", 502);
      }
      throw err;
    }

    // 반환 entry 의 event_id 재검증(심층방어): v2 WHERE 가 이미 차단하나, 계약 회귀 시
    //   엉뚱한 이벤트 entry 가 반환되면 즉시 404 로 끊는다(크로스이벤트 누출 최종 게이트).
    if (entry.event_id !== params.eventId) {
      logger.warn("대기열 전이 반환 entry 의 event_id 불일치(경계 위반 차단)", {
        entryId: params.entryId, expected: params.eventId, got: entry.event_id,
      });
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // 제안 전이일 때만 발송 배선.
    // ── W2-PS — 컨텍스트(이벤트 제목/슬러그·상품명/가격)를 go `events JOIN products` 에서 v2 로 이관 ──
    // 🔴 상태는 이미 v2 에 확정(committed)됐다. 컨텍스트 조회 실패로 상태를 되돌리지 않으며,
    //    발송만 생략하고 `offerSent:false` 로 정직하게 알린다(200 은 상태 전이 성공을 뜻한다).
    if (body.status === "offered") {
      let ctx: { eventTitle: string; eventSlug: string; productName: string; unitPrice: number } | null = null;
      try {
        const event = await requireOwnedEvent(params.eventId, session.accountId);
        const product = (await loadCatalog(event.event_id)).find(
          (e) => e.ref === entry.product_id,
        );
        if (product) {
          ctx = {
            eventTitle: event.title,
            eventSlug: event.slug,
            productName: product.row.name,
            unitPrice: Number(product.row.base_price ?? 0),
          };
        }
      } catch (ctxErr: unknown) {
        if (!(ctxErr instanceof EventAccessError) && !(ctxErr instanceof V2CommerceError)) throw ctxErr;
        logger.warn("대기자 제안 컨텍스트 조회 실패(상태는 offered 유지, 발송 생략)", {
          entryId: params.entryId,
          eventId: params.eventId,
        });
      }
      if (ctx) {
        const expiresAtMs = entry.expires_at ? new Date(entry.expires_at).getTime() : Date.now();
        const offerCtx: WaitlistOfferContext = {
          accountId: session.accountId,
          eventId: params.eventId,
          eventSlug: ctx.eventSlug,
          eventTitle: ctx.eventTitle,
          entryId: params.entryId,
          name: entry.name,
          email: entry.email,
          productName: ctx.productName,
          unitPrice: ctx.unitPrice,
          expiresAtMs,
          tokenVersion: entry.offer_token_version,
        };
        try {
          const send = await sendWaitlistOffer(offerCtx);
          return successResponse({ id: entry.id, status: body.status, offerSent: send.emailSent, simulated: send.simulated });
        } catch (sendErr: unknown) {
          logger.warn("대기자 제안 발송 실패(상태는 offered 유지)", {
            entryId: params.entryId,
            error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
          return successResponse({ id: entry.id, status: body.status, offerSent: false });
        }
      }
      // 컨텍스트 미확보(상품 삭제·v2 장애) — 전이는 성공이지만 발송은 못 했다고 정직히 알린다.
      return successResponse({ id: entry.id, status: body.status, offerSent: false });
    }

    return successResponse({ id: entry.id, status: body.status });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    // 이벤트 경계(P1): eventId 를 v2 삭제 계약에 포함 → 크로스이벤트 삭제 차단.
    await deleteWaitlistEntry(params.entryId, session.accountId, params.eventId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      logger.warn("대기열 삭제 v2 실패", { entryId: params.entryId, status: err.status });
      return errorResponse("대기열 항목 삭제에 실패했습니다", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
