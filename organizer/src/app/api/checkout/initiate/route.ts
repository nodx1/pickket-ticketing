import { z } from "zod";
import { cookies } from "next/headers";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { ERR } from "@/lib/errors";
import { calculatePlatformFee, getAccountFeePlan } from "@/lib/fee/calculator";
import { createOrder } from "@/lib/server/orders";
import { recordConsent } from "@/lib/notification/compliance";
import { MARKETING_CONSENT_VERSION } from "@/lib/notification/consent-wording";
import { logger } from "@/lib/logger";
import { bankInfoFromEnv, isOfflinePaymentAvailable, paymentDeadlineISO } from "@/lib/checkout/offline-payment";
import { getEvent, getTiersByEvent, validatePromoCode, prepareNicePayment, V2CommerceError, v2ErrorCode } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";
import { findNonPurchasable } from "@/lib/v2/public-purchasable";
import { consumeQueueAdmission } from "@/lib/queue/smart-queue";

const initiateSchema = z.object({
  eventId: z.string().uuid(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ).min(1, "상품을 선택해주세요"),
  buyerName: z.string().min(2, "이름을 입력해주세요"),
  buyerEmail: z.email("올바른 이메일 형식을 입력해주세요"),
  buyerPhone: z.string().min(10, "전화번호를 입력해주세요"),
  receiptType: z.enum(["none", "tax_invoice", "cash_receipt"]).optional(),
  businessNumber: z.string().optional(),
  companyName: z.string().optional(),
  identityNumber: z.string().optional(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  selectedSeatIds: z.array(z.string().uuid()).optional(),
  finalAmount: z.number().nonnegative().optional(),
  promoCode: z.string().optional(),
  source: z.enum(["direct", "widget", "marketplace", "affiliate", "api"]).optional().default("direct"),
  holdId: z.string().uuid().optional(),
  holdToken: z.string().optional(),
  // §3-2: 마케팅 수신동의(선택, 기본 미체크). true 일 때만 동의 기록.
  marketingConsent: z.boolean().optional(),
  /**
   * 레벨2 재감사 P1 — createOrder retry idempotency(호출자 durable key).
   * 프론트(체크아웃 UI)가 **체크아웃 진입 시 1회 생성**(crypto.randomUUID)한 안정 토큰.
   * 같은 체크아웃의 재시도(네트워크 오류·더블클릭·뒤로가기 재진입)는 같은 토큰을 재전송 →
   * createOrder 가 external_order_id 를 결정적 파생 → v2 external_order_id UNIQUE dedup 이
   * 중복 v2주문/좌석hold 를 흡수한다. 미전송(구버전 클라)이면 매 요청 신규 주문(하위호환).
   */
  idempotencyToken: z.string().uuid(),
  // 나이스페이(구형) 결제수단 선택값 — provider=nicepay 일 때 v2 prepare 의 pay_method 로 전달
  // (서버가 화이트리스트 정규화 후 payForm.PayMethod 로 주입).
  payMethod: z.string().optional(),
  /**
   * 카드사 자동할인 선택(T14) — 예: "BC". 고객이 결제수단에서 고른 카드사.
   * ⚠️ 클라는 **카드사 키만** 보낸다. 할인율·할인코드는 서버가 이벤트 설정에서 해석한다
   *    (클라가 코드를 주장하면 임의 할인이 된다).
   */
  cardDiscount: z.string().max(16).optional(),
  /**
   * 🔴 구매자가 **무통장입금**으로 진행한다는 선언. true 면 나이스 prepare 를 타지 않는다.
   *
   * 왜 필요한가 — prepare 는 v2 `orders.payment_id` 를 세팅한다. 무통장 주문에도
   * 무조건 prepare 를 돌리면 "PG 결제가 걸린 주문" 과 구분이 사라지고,
   * 주최자 입금확정 게이트(`deposit-eligibility`: has_pg_payment)가 **정상 무통장 주문을
   * 막는다**(옆세션 bb2ec2d2 검수에서 실행으로 확인). 덤으로 무통장 주문이 나이스
   * prepare 실패에 502 로 끌려가던 것도 사라진다.
   */
  offlinePayment: z.boolean().optional(),
  termsAgreedAt: z.string().datetime().optional(),
  queueSessionToken: z.string().min(16).max(128).optional(),
  queueAccessToken: z.string().min(16).max(128).optional(),
});

async function checkoutInitiateHandler(request: Request) {
  try {
    const body = initiateSchema.parse(await request.json());
    const cookieStore = await cookies();

    // 🔴 무통장입금은 **계좌 안내가 있어야만** 받는다 (2026-07-30 실측).
    //    prod 는 NEXT_PUBLIC_BANK_* 가 빈 문자열이라 화면에 은행명·계좌번호·예금주가
    //    전부 빈칸으로 나갔다 — 구매자가 돈 보낼 곳이 없는데 주문은 생성됐다.
    //    화면에서도 선택지를 숨기지만, 서버가 마지막 관문이다(직접 호출 차단).
    if (body.offlinePayment && !isOfflinePaymentAvailable()) {
      logger.error("무통장입금 주문 거부 — 입금 계좌 안내 미설정", {
        missing: (() => {
          const r = bankInfoFromEnv();
          return r.ok ? [] : r.missing;
        })(),
      });
      return errorResponse("무통장입금은 현재 이용할 수 없습니다. 카드 결제를 이용해주세요.", 503);
    }

    // 🔴 기한은 결제수단별로 다르다. 종전엔 여기서 **무조건 15분**을 계산해
    //    무통장 주문도 15분에 만료됐다(화면 안내는 3일). 단일 출처로 옮겼다.
    const expiresAt = paymentDeadlineISO(new Date(), body.offlinePayment === true);
    // W5-COMMERCE: 프로모코드 조회가 v2 로 옮겨가면서 이 라우트의 go DB 직접 접근이 0 이 됐다.

    // ── W2-ORD: go `SELECT account_id, sale_channels, v2_event_id, queue_enabled FROM events` 폐기 ──
    // 네 값 전부 v2 이벤트 상세가 이미 내려준다(go_account_id / sale_channels / queue_enabled,
    // event id 는 항등). 비인증 공개 라우트라 organizer_ref 없이 조회하고 accountId 를 v2 에서 받는다.
    // 🔴 fail-closed: v2 404 = 없는 행사(404). v2 5xx/네트워크 = **503**(재시도 가능) —
    //    404 나 400 으로 뭉개면 "행사가 사라졌다"로 오인되고 재시도 판단이 불가능해진다.
    let eventDetail: Awaited<ReturnType<typeof getEvent>>;
    try {
      eventDetail = await getEvent(body.eventId);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
        return errorResponse("행사 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }

    const accountId = eventDetail.go_account_id ?? "";
    if (!accountId) {
      // v2 네이티브 주최자(go 계정 미연결) — go 정산·수수료 플랜을 붙일 수 없어 결제 진입 불가.
      // (옛 코드의 "go events 행 없음 → 404" 와 동일 지점.)
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // Phase 0 채널 gate: go self-checkout 은 'self' 채널 행사에만 허용.
    // self 가 없는 행사(marketplace 전용)는 go 직접결제 대상이 아니므로 거부 →
    // 채널별 주문 분리(split-brain 봉쇄). (sale_channels 기본값 {self}, migration 108)
    const saleChannels = eventDetail.sale_channels?.length ? eventDetail.sale_channels : ["self"];
    if (!saleChannels.includes("self")) {
      return errorResponse("이 행사는 직접 구매를 지원하지 않습니다", 403);
    }

    // 레벨2 read-flip: 금액 정본 = v2 tier.base_price (go products.price 직접 read 폐기).
    //   write-through 로 go products.price ↔ v2 tier.base_price 는 동일 보장되므로 전환으로
    //   금액이 바뀌지 않는다(v2 가 정본). 클라이언트 금액은 신뢰하지 않고 v2 tier 로만 합산.
    const v2EventId = eventDetail.event_id;
    const itemIds = body.items.map((i) => i.productId);
    let tierMap: Awaited<ReturnType<typeof getTiersByEvent>>;
    try {
      tierMap = await getTiersByEvent(v2EventId);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        return errorResponse(`상품 정보를 불러오지 못했습니다 (v2: ${err.message})`, 502);
      }
      throw err;
    }
    // 요청한 모든 상품이 v2 티어(external_ref=productId)로 해석되는지 확인 — 없는 상품을 0원으로 흘려보내지 않음.
    // 🔴 그리고 **공개 판매 가능한 티어인지**까지 본다 (2026-08-01 오픈 직전 발견).
    //    종전엔 "이 행사 티어인가" 만 봤다. 공개 상세 화면은 `visibility` 로 숨김 티어를
    //    빼는데 여기는 안 봐서, **메뉴판에선 빠지는데 주문은 받아주는** 상태였다.
    //    초대권(0원·정원 100만) 티어 ID 를 아는 사람이 직접 호출하면 0원 주문이 성립하고,
    //    발권된 티켓은 정상 초대권과 구분되지 않는다(게이트는 등급 가격을 보지 않는다).
    //    ⟹ 대표 지시: **초대권 발급은 대시보드에서만.** 판정은 `lib/v2/public-purchasable.ts`.
    const blocked = findNonPurchasable(tierMap, itemIds);
    if (blocked) {
      // ⚠️ 사용자에게 사유를 나누어 알려주지 않는다 — "숨김 상품이 존재한다" 는 것 자체가
      //    탐색 단서다. 로그에만 남긴다.
      logger.warn("[checkout] 공개 구매 불가 상품 요청", {
        eventId: body.eventId,
        productId: blocked.productId,
        reason: blocked.reason,
      });
      return errorResponse("유효하지 않은 상품이 포함되어 있습니다", 400);
    }
    const serverTotal = body.items.reduce(
      (sum, i) => sum + Number(tierMap.get(i.productId)?.base_price ?? 0) * i.quantity,
      0,
    );

    // ── W5-COMMERCE: 프로모코드 정본 = v2 discount_codes (go `promo_codes` 폐기) ──
    // 🔴 할인액을 go 가 재계산하지 않는다. 실제 청구액은 v2 가 주문 생성 시
    //   `_compute_discount_amount` 로 산정하는데, 여기서 다른 산식(반올림·최소주문액·
    //   최대할인캡 미반영)을 쓰면 v2 의 total_amount 재검증이 AMOUNT_MISMATCH 로 결제를
    //   거절한다. 검증 엔드포인트가 **그 함수 그대로** 계산한 값을 받아 쓴다.
    // 🔴 사용횟수는 여기서 차감되지 않는다(차감 = 주문 생성 트랜잭션 1회, FOR UPDATE).
    //   한도 초과·만료·비활성은 v2 가 이 단계에서도 막는다(fail-closed).
    // 🔴 v2 장애를 "할인 0원" 으로 흘리지 않는다 — 503 으로 끊는다.
    // ── 🔴 T14: 카드사 자동할인 — 서버가 코드를 붙인다 ────────────────────────────
    // 클라가 보낸 건 카드사 키("BC")뿐이고, 실제 할인코드는 v2 이벤트 설정에서 읽는다.
    // 금액은 여기서 깎지 않는다 — v2 가 주문 생성 시 그 코드로 **재계산**한다
    // (go 가 임의 금액을 보내면 AMOUNT_MISMATCH 로 거절된다. 그게 설계된 방어선이다).
    let effectivePromoCode = body.promoCode;
    if (body.cardDiscount) {
      // 🔴 카드사 할인은 **카드 결제에만** 성립한다. 무통장입금·계좌이체·가상계좌는
      //    카드사가 개입하지 않으므로 T15 가 영영 돌지 않는다 → 검증 없는 순손실.
      //    클라도 선택을 해제하지만 서버가 최종 방어선이다(클라는 우회 가능).
      // 🔴 CARD 만 허용한다. EASYPAY/CARDANDEASYPAY 를 넣으면 안 된다 — 간편결제는
      //    SelectCardCode 로 카드사를 제한할 수 없어(구형 나이스 스펙 미확정, 계획 §4)
      //    다른 카드로 승인된 뒤 T15 가 승인취소한다 = 고객이 결제→취소를 겪는다.
      //    payMethod 미지정(토스 등 payMethod 를 안 쓰는 provider)은 통과시키고
      //    카드사 검증은 T15 가 provider 무관하게 담당한다.
      if (body.offlinePayment) {
        return errorResponse("카드사 할인은 카드 결제에만 적용됩니다", 400);
      }
      const cardEligible = !body.payMethod || body.payMethod.trim().toUpperCase() === "CARD";
      if (!cardEligible) {
        return errorResponse("카드사 할인은 카드 결제에만 적용됩니다", 400);
      }
      const cfg = eventDetail.card_discounts?.[body.cardDiscount];
      if (!cfg?.discount_code) {
        // 이 행사에 없는 카드사 할인을 주장했다 — 조용히 무시하면 고객은 할인가를 본 채
        // 정가로 결제된다. 명시적으로 막는다.
        return errorResponse("선택하신 카드사 할인을 사용할 수 없습니다", 400);
      }
      if (body.promoCode) {
        // v2 는 주문당 할인코드 1개만 적용한다 — 어느 쪽을 버릴지 서버가 임의로 정하면
        // 고객이 본 금액과 달라진다. 선택을 되돌리게 한다.
        return errorResponse("카드사 할인과 프로모코드는 함께 사용할 수 없습니다", 400);
      }
      effectivePromoCode = cfg.discount_code;
    }

    let promoCodeId: string | undefined;
    let discountAmount: number | undefined;
    if (effectivePromoCode) {
      try {
        const promo = await validatePromoCode(v2EventId, {
          code: effectivePromoCode.toUpperCase(),
          gross_amount: serverTotal,
        });
        promoCodeId = promo.promo_id;
        discountAmount = promo.discount_amount;
      } catch (err: unknown) {
        if (err instanceof V2CommerceError) {
          if (err.status >= 400 && err.status < 500) {
            return errorResponse("유효하지 않은 프로모코드입니다", 400);
          }
          return errorResponse(
            "프로모코드를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
            503,
          );
        }
        throw err;
      }
    }

    // 서버 권위 금액: 상품 합계 - 프로모 할인.
    // 클라이언트 finalAmount 는 표시용일 뿐 — 절대 신뢰하지 않고 서버 계산값만 사용한다.
    const serverFinalAmount = Math.max(0, serverTotal - (discountAmount ?? 0));
    // 구형 나이스: 현금영수증은 계약 배선 전까지 미지원. 동의 시각은 유료 주문에 필수.
    if (body.receiptType === "cash_receipt") {
      return errorResponse("현금영수증은 NICE 계약 배선 전까지 지원하지 않습니다", 400);
    }
    if (serverFinalAmount > 0 && !body.termsAgreedAt) {
      return errorResponse("전자금융거래·청약철회 동의가 필요합니다", 400);
    }

    const affiliateRef =
      cookieStore.get("pickket_affiliate_ref")?.value?.trim() || null;

    // Queue admission is a Redis CAS bound to this checkout's durable
    // idempotency token. Same-request retries replay; a different cart/token
    // cannot reuse the slot.
    if (eventDetail.queue_enabled) {
      if (!body.queueSessionToken || !body.queueAccessToken) {
        return errorResponse("구매 대기열 입장 토큰이 필요합니다", 403);
      }
      try {
        await consumeQueueAdmission(
          body.eventId,
          body.queueSessionToken,
          body.queueAccessToken,
          body.idempotencyToken,
        );
      } catch (err: unknown) {
        if (err instanceof V2CommerceError) {
          return errorResponse(
            err.status === 403
              ? "대기열 입장 토큰이 만료되었거나 이미 사용되었습니다"
              : "대기열 확인에 실패했습니다",
            err.status === 403 ? 403 : 503,
          );
        }
        return errorResponse("대기열 확인에 실패했습니다", 503);
      }
    }

    // W2-ORD: 수수료는 **주문 생성 전에** 산정해 앵커 INSERT 에 함께 싣는다.
    //   옛 코드는 createOrder 직후 `UPDATE orders SET platform_fee = $2` 로 별도 go write 를
    //   한 번 더 했다. 그 컬럼은 어디서도 SELECT 되지 않고(정산·인보이스 전부 v2 platform_fee
    //   SoT — grep 실측), 게다가 그 UPDATE 가 실패하면 주문은 생성됐는데 500 이 나가
    //   "실패로 보이는 성공"을 만들었다. 별도 write 를 없애고 값은 그대로 보존한다.
    //   금액은 serverFinalAmount(= createOrder 의 totalAmountOverride)와 동일 기준.
    // 🔴 T17: "플랜 없음 → 0원" 이 fail-closed 를 마지막 홉에서 무너뜨리고 있었다.
    //    v2 조회 **실패**는 예외로 올라와 아래 catch 가 503 으로 막지만(정상),
    //    "유효 스케줄 없음"(null)은 조용히 수수료 0 으로 흘러 v2 원장에 **동결**됐다.
    //    되돌릴 수 없는 조용한 매출 손실이고, 로그도 알림도 없었다.
    //
    //    정책 확정: **null 이면 결제를 막는다.**
    //    근거 — v2 는 이미 organizer → platform 스코프 폴백을 한다
    //    (internal_commerce_read.py 의 fee-plan 엔드포인트). 따라서 null 이 나온다는 것은
    //    **플랫폼 기본 수수료 스케줄조차 없다**는 뜻이고, 정상 운영에서는 발생할 수 없는
    //    설정 사고다. 그 상태로 주문을 받으면 그 주문들의 수수료가 영구히 0 이 된다.
    //    판매를 잠깐 멈추는 쪽이 조용한 손실보다 낫다 — 멈추면 즉시 발견되고 복구 후 재개된다.
    const feePlan = await getAccountFeePlan(accountId);
    if (!feePlan) {
      logger.error("[checkout] 유효한 수수료 스케줄이 없어 결제를 차단했습니다", {
        accountId,
        eventId: body.eventId,
        hint: "v2 fee_schedules 에 platform 스코프 활성 행(effective_until IS NULL)이 있는지 확인",
      });
      return errorResponse("결제를 시작할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    const platformFee = calculatePlatformFee(feePlan, serverFinalAmount);

    const result = await createOrder({
      accountId,
      platformFee,
      eventId: body.eventId,
      buyerName: body.buyerName,
      buyerEmail: body.buyerEmail,
      buyerPhone: body.buyerPhone,
      items: body.items,
      answers: body.answers,
      selectedSeatIds: body.selectedSeatIds,
      // 🔴 종전엔 무조건 `"offline"` 이었다 (2026-08-01 실사고).
      //    이 시점엔 **결제수단을 모른다** — 카드·간편결제도 여기를 지난다. 그런데
      //    "현장결제" 라고 단정해 적었고, 카드 결제하다 이탈하면 그 값이 그대로 남아
      //    주최자 대시보드에 **현장결제로 표시**됐다(실제 신고). prod 이탈 4건이 전부
      //    그 상태였다. v2 는 같은 주문을 `payment_method=NULL` 로 정직하게 적는다.
      //
      //    ⚠️ 단순 NULL 로만 두면 안 된다. `bank_transfer` 를 찍는 유일한 경로가
      //    `checkout/complete` 라서, 무통장을 고르고 거기 도달 전에 이탈하면 NULL 로
      //    남아 **주최자가 실입금을 받고도 확정할 수단이 없다**(입금확정 게이트가
      //    NULL 을 거절). 다행히 이 시점에 무통장 의사는 이미 안다(`body.offlinePayment`).
      //    ⟹ 의사표시가 있으면 그때 명시하고, 없으면 모른다고 남긴다.
      paymentMethod: body.offlinePayment ? "bank_transfer" : null,
      status: "pending",
      paymentStatus: "pending",
      totalAmountOverride: serverFinalAmount,
      expiresAt,
      promoCodeId,
      promoCode: effectivePromoCode,
      discountAmount,
      source: body.source,
      // v2 createOrder가 같은 트랜잭션에서 conversion을 기록한다. go
      // affiliate_conversions 후속 INSERT는 정본 분리를 만들므로 사용하지 않는다.
      affiliateRef,
      holdId: body.holdId,
      holdToken: body.holdToken,
      // 호출자 durable key: 같은 체크아웃 재시도 → 같은 external_order_id → v2 dedup 흡수.
      idempotencyToken: body.idempotencyToken,
      termsAgreedAt: body.termsAgreedAt,
    });

    // §3-2: 마케팅 수신동의 취득 — 체크 시에만 이 이벤트 주최 계정 대상 이메일·SMS 동의 기록(best-effort).
    if (body.marketingConsent) {
      try {
        await recordConsent(accountId, "email", body.buyerEmail, { source: "checkout", wordingVersion: MARKETING_CONSENT_VERSION });
        await recordConsent(accountId, "sms", body.buyerPhone, { source: "checkout", wordingVersion: MARKETING_CONSENT_VERSION });
      } catch (consentErr) {
        logger.warn("마케팅 수신동의 기록 실패(무시)", {
          error: consentErr instanceof Error ? consentErr.message : "unknown",
        });
      }
    }

    // httpOnly: true — JS 접근 차단으로 XSS 시 orderId PII 노출 방지 (#30 수정).
    cookieStore.set("pickket_last_order", result.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // 결정 B(서버주도 provider 라우팅): 신규 go 주문의 기본 PG 를 서버 config 로 결정해
    // 프론트에 내린다 — 프론트가 env 만 보고 분기하지 않도록(서버주도). 값은 화이트리스트
    // (toss|nicepay)로 정규화한다. 주문 확정·승인은 v2 소유이므로 여기선 결제창 분기용 힌트.
    // NEXT_PUBLIC_* 는 빈 문자열 주입 가능 → `||` 폴백(아키맵 함정3, `??` 금지).
    // 🔴 기본값을 nicepay 로 (2026-07-28 대표 결정).
    //    예전 기본값은 "toss" 였다. prod 3개 앱 어디에도 PAYMENT_PROVIDER 가 없어서
    //    (CapRover 실측: organizer env 33개 중 결제 관련 0개) **NICE UI 를 다 만들어
    //    연결해놨는데도 결제창이 Toss 로 열리고 있었다.** 결정된 PG 가 기본이어야 하고
    //    옛 PG 는 명시 선택이어야 한다 — 지금까지 정반대였다.
    //    Toss 로 보내려면 이제 PAYMENT_PROVIDER=toss 를 **명시**해야 한다.
    const rawProvider = (
      process.env.PAYMENT_PROVIDER ||
      process.env.NEXT_PUBLIC_PAYMENT_PROVIDER ||
      "nicepay"
    ).toLowerCase();
    const provider = rawProvider === "nicepay" || rawProvider === "nice" ? "nicepay" : "toss";

    // ── 나이스 구형 결제창(goPay 폼 POST) 준비 ──────────────────────────────
    // 서버가 v2 prepare 로 payForm(provider_params)을 계산해 프론트에 내린다.
    // SignData 는 v2 시크릿으로만 만들 수 있어 클라이언트가 계산할 수 없다.
    //   · success_url/fail_url = "go" 는 origin 센티넬(MallReserved='go').
    //     v2 return 핸들러가 이를 읽어 go 전역 랜딩으로 302 — 목적지 URL 은 v2 config 라
    //     open-redirect 가 원천 차단된다.
    //   · pay_method = 사용자 선택 결제수단(서버 화이트리스트 정규화).
    // 🔴 prepare 실패를 결제 성공으로 위장하지 않는다. 주문은 pending 앵커로 남기고
    //    호출자에게 명시적 오류를 반환해 재시도·운영조사가 가능하게 한다.
    let providerParams: { js_url: string; form: Record<string, string> } | null = null;
    // 무통장입금은 PG 결제창이 없다 → prepare 를 타지 않는다(payment_id 미세팅 = 입금확정 대상).
    if (provider === "nicepay" && !body.offlinePayment && result.totalAmount > 0 && result.v2OrderId) {
      try {
        const prepared = await prepareNicePayment(result.v2OrderId, {
          success_url: "go",
          fail_url: "go",
          pay_method: body.payMethod ?? null,
          idempotency_key: `go-nice-prepare:${result.id}`,
        });
        providerParams = prepared.provider_params ?? null;
      } catch (prepareErr) {
        logger.error("나이스 구형 prepare 실패 — 결제창을 열지 않음", {
          orderId: result.id,
          error: prepareErr instanceof Error ? prepareErr.message : "unknown",
        });
        return errorResponse("나이스 결제창을 준비하지 못했습니다. 잠시 후 다시 시도해주세요", 502);
      }
      if (!providerParams) {
        return errorResponse("나이스 결제창 파라미터가 없습니다", 502);
      }
    }

    return successResponse(
      {
        orderId: result.id,
        shortId: result.orderNumber,
        totalAmount: result.totalAmount,
        provider,
        // 🔴 키 이름은 snake — 클라이언트(checkout-payment-step)가 `provider_params` 로 읽는다.
        //    camelCase 로 내리면 결제창 파라미터가 undefined 가 되어 **나이스 창이 안 열린다**.
        provider_params: providerParams,
      },
      201,
    );
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    // 🔴 W2-ORD fail-closed: createOrder 의 소유/가용성 오류를 400 "입력 오류"로 위장하지 않는다.
    //   - not_found: 없거나 내 것이 아님 → 404
    //   - unavailable: v2 장애 → 503(재시도 가능). 400 이면 구매자가 "내 입력이 틀렸다"고
    //     오인하고 클라이언트도 재시도하지 않는다.
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse(ERR.NOT_FOUND, 404)
        : errorResponse("결제를 시작할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      // 🔴 「체크아웃 토큰이 가리키는 주문이 되살릴 수 없다」 — 손님 잘못도 서버 장애도
      //    아니고, **토큰을 버리면 즉시 풀린다**. 그래서 코드를 살려 화면까지 내려보낸다.
      //
      //    ⚠️ 이걸 5xx 로 뭉개면 안 된다. go 앞단이 Cloudflare 라(응답 헤더 실측:
      //       server: cloudflare) 5xx 가 비JSON 으로 바뀌면 화면이 "(오류 502)" 만 보고
      //       **영원히 재시도**한다 — 같은 토큰이라 매번 같은 만료 주문을 만난다.
      //       4xx + JSON 은 CF 를 그대로 통과하는 것을 실측으로 확인했다.
      if (v2ErrorCode(err) === "ORDER_NOT_REPLAYABLE") {
        return errorResponse(
          "이전 주문이 만료되었습니다. 새로 주문해 주세요.",
          409,
          "ORDER_NOT_REPLAYABLE",
        );
      }
      // 4xx = 재고부족·검증실패 등 사용자에게 의미 있는 거절, 5xx = 일시 장애.
      return err.status >= 400 && err.status < 500
        ? errorResponse(err.message, err.status)
        : errorResponse("결제를 시작할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof Error) {
      return errorResponse(err.message, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "checkout:initiate",
})(checkoutInitiateHandler);
