/**
 * 대기자 구매 제안 "claim"(공개) — 딥링크 토큰으로 offered 대기건을 주문으로 전환한다.
 *
 * 인증 없음. 접근 통제는 서명 딥링크 토큰(HMAC) + expires_at + offer_token_version 대조로 한다.
 *
 * 레벨2 컷오버(스코프A): 대기열 정본이 v2 로 이관됨 → go DB 직접참조 폐기. claim 은 v2 3-phase:
 *   1) claim-begin : offered → converted 원자 CAS(동시 2회 중 한쪽만 획득).
 *   2) createOrder : go 주문 생성(외부 v2 커머스). 실패 시 claim-abort 로 offered 복구(보상).
 *   3) claim-commit: converted_order_id 앵커 기록(재-claim 멱등 앵커).
 *
 * ⚠️ claim-commit 실패 처리(P1 재감사): 앵커 기록이 실패하면 entry 는 converted·앵커=NULL 로
 *   잔류하고 주문과의 연결이 끊긴다(재-claim 409·orphan). 이 경우 **201 이 아니라 502** 를 반환하고
 *   복구 큐(waitlist_claim_recovery)에 (entryId, orderId)를 기록해 재조정 워커가 동일 order 로
 *   재-commit(앵커 수렴)하게 한다. 성공(201)응답은 앵커가 확인된 뒤에만 나간다.
 *
 * 멱등성/동시성:
 *   - 이미 converted+order_id → 멱등 재생(alreadyClaimed).
 *   - 경쟁 패자는 승자의 converted_order_id 를 재생하거나, 승자 커밋 전이면 409(재시도 가능).
 *   - createOrder 성공 후 crash → claim-commit 미기록이지만 재-claim 시 claim-begin 이
 *     이미 converted 라 already_claimed=false·order 없음 → 409 로 재시도 유도(중복 주문은
 *     createOrder external_order_id 멱등이 아닌 새 orderId 라 이론상 재생성 가능 →
 *     claim-commit 이 최초 order 만 앵커, 이후 재-claim 은 앵커된 order 재생).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { isProdRuntime } from "@/lib/env/runtime";
import { rateLimitKey } from "@/lib/request-ip";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { createOrder } from "@/lib/server/orders";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { claimAbort, claimBegin, claimCommit, getWaitlistEntry } from "@/lib/v2/waitlist-client";
import { recordWaitlistClaimRecovery } from "@/lib/waitlist/claim-recovery";
import { alertWaitlistRecovery } from "@/lib/waitlist/recovery-alert";
import { verifyWaitlistOfferToken } from "@/lib/waitlist/offer-token";

type Params = { entryId: string };

const schema = z.object({
  token: z.string().min(10).max(1024),
});

const IP_LIMIT = { windowMs: 60_000, max: 10, onRedisError: "closed" as const };

export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const { entryId } = await context.params;
    const bucket = rateLimitKey(request.headers, isProdRuntime());
    if (bucket === null) return errorResponse("요청을 처리할 수 없습니다", 503);
    const rl = await checkRateLimit(`waitlist-claim:ip:${bucket}`, IP_LIMIT);
    if (!rl.success) return errorResponse("요청이 너무 많습니다", 429);

    const body = schema.parse(await request.json());
    const claims = verifyWaitlistOfferToken(body.token);
    if (!claims || claims.entryId !== entryId) {
      return errorResponse("유효하지 않은 구매 링크입니다", 403);
    }
    if (claims.expiresAtMs < Date.now()) {
      return errorResponse("구매 기한이 만료되었습니다", 410);
    }

    // 대기건 스냅샷(v2 정본). account 경계는 딥링크 토큰이 대체(entry_id 고정).
    const entry = await getWaitlistEntry(entryId).catch((err: unknown) => {
      if (err instanceof V2CommerceError && err.status === 404) return null;
      throw err;
    });
    if (!entry) return errorResponse(ERR.NOT_FOUND, 404);

    // 이미 전환됨 → 멱등 재생.
    if (entry.status === "converted" && entry.converted_order_id) {
      return successResponse({ orderId: entry.converted_order_id, alreadyClaimed: true });
    }
    // 토큰 version 대조 — 재발송으로 이전 토큰이 무효화됐으면 거부.
    if (claims.version !== entry.offer_token_version) {
      return errorResponse("만료되었거나 대체된 구매 링크입니다", 410);
    }
    if (entry.status !== "offered") {
      return errorResponse("현재 구매할 수 없는 대기 상태입니다", 409);
    }
    // DB expires_at 재확인(토큰 임베드값과 별개 최종 게이트).
    if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
      return errorResponse("구매 기한이 만료되었습니다", 410);
    }

    // ── 1) 원자 claim 획득(v2 CAS): offered → converted. 동시 2회 중 한쪽만 성공. ──
    const begin = await claimBegin(entryId);
    if (!begin.claimed) {
      // 승자가 기록한 주문을 재생하거나(alreadyClaimed), 승자 커밋 전이면 409.
      if (begin.already_claimed && begin.converted_order_id) {
        return successResponse({ orderId: begin.converted_order_id, alreadyClaimed: true });
      }
      return errorResponse("현재 구매할 수 없는 대기 상태입니다", 409);
    }

    // ── 2) claim 획득 성공 → 주문 생성(외부 v2). 실패 시 claim-abort 로 offered 복구. ──
    try {
      const order = await createOrder({
        accountId: entry.account_id,
        eventId: entry.event_id,
        buyerName: entry.name,
        buyerEmail: entry.email,
        buyerPhone: entry.phone ?? undefined,
        items: [{ productId: entry.product_id, quantity: 1 }],
        paymentMethod: "toss",
        status: "pending",
        paymentStatus: "pending",
        source: "direct",
        idempotencyToken: `waitlist-claim:${entryId}`,
      });
      // ── 3) 전환 주문 앵커 기록(v2) — 재-claim 멱등 대상. ──
      //   앵커 기록이 실패하면 entry 는 converted·converted_order_id=NULL 로 잔류하고, 재-claim 은
      //   409(재시도 불가)·주문↔entry 연결끊김(orphan) 이 된다. 이때 201 성공을 반환하면 go↔v2
      //   split-brain 이 확정된다 → **성공응답은 앵커 확인 후에만**. 실패 시 복구 큐 기록 + 502.
      let committed = false;
      let commitErr: unknown = null;
      try {
        const commit = await claimCommit(entryId, order.id);
        // committed=true(이번에 앵커 기록) 또는 이미 같은 order 로 앵커돼 있으면(멱등 재생) 성공으로 본다.
        committed = commit.committed || commit.converted_order_id === order.id;
        if (!committed) {
          commitErr = new Error(
            `claim-commit anchor mismatch: got ${commit.converted_order_id ?? "null"}`,
          );
        }
      } catch (err: unknown) {
        commitErr = err;
      }

      if (!committed) {
        // 앵커 미확인 → 복구 큐에 기록(재조정 워커가 동일 order 로 재-commit)하고 502 반환.
        const rec = await recordWaitlistClaimRecovery({
          entryId,
          orderId: order.id,
          accountId: entry.account_id,
          eventId: entry.event_id,
          error: commitErr instanceof Error ? commitErr.message : String(commitErr),
        });
        logger.error("대기자 claim 앵커 기록 실패 — 복구 큐 기록 후 502", {
          entryId,
          orderId: order.id,
          recovered: rec.recorded,
          error: commitErr instanceof Error ? commitErr.message : String(commitErr),
        });
        // 복구 큐 기록마저 실패 → converted-미앵커 entry 가 큐에조차 없어 드레인 워커가 손댈 수 없다
        // (복구 불가능 상태). logger.error 만으론 운영이 놓칠 수 있으므로 Sentry 로 승격(복구 보장).
        if (!rec.recorded) {
          alertWaitlistRecovery({
            kind: "queue_write_failed",
            entryId,
            orderId: order.id,
            accountId: entry.account_id,
            eventId: entry.event_id,
            reason: "recovery_queue_insert_failed",
          });
        }
        return errorResponse("구매 처리가 지연되고 있습니다. 잠시 후 다시 시도해주세요", 502);
      }

      logger.info("대기자 claim 주문 생성", { entryId, orderId: order.id });
      return successResponse({ orderId: order.id, orderNumber: order.orderNumber, totalAmount: order.totalAmount }, 201);
    } catch (err: unknown) {
      // 보상: 주문 생성 실패 → offered 로 되돌려 재시도 가능하게 한다.
      await claimAbort(entryId).catch((abortErr: unknown) => {
        logger.error("대기자 claim 보상(abort) 실패 — converted 잔류", {
          entryId,
          error: abortErr instanceof Error ? abortErr.message : String(abortErr),
        });
      });
      logger.warn("대기자 claim 주문 생성 실패 — offered 복구", {
        entryId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof V2CommerceError) {
        return errorResponse(err.message || "주문 생성에 실패했습니다", 502);
      }
      return errorResponse(err instanceof Error ? err.message : "주문 생성에 실패했습니다", 400);
    }
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    if (err instanceof V2CommerceError) {
      logger.warn("대기자 claim v2 오류", { status: err.status });
      return errorResponse("구매 처리에 실패했습니다", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}
