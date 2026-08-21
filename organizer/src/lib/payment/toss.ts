import type { CancelResult, PaymentProvider, PaymentResult } from "@/lib/payment/types";

const TOSS_API_URL = "https://api.tosspayments.com/v1";

export class TossAmbiguousError extends Error {
  readonly ambiguous = true;
  constructor(message: string, readonly paymentKey: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "TossAmbiguousError";
  }
}

/**
 * 조회 실패(네트워크·타임아웃·401·5xx) — "결제 없음(null)"과 명확히 구분한다.
 * 감사 P1-10: 조회 장애를 정상 pending 으로 위장하면 orphan scanner 의 degraded 가
 * 발화하지 않는다. fail-closed 로 호출자에게 전파해 lookupFailed/degraded 로 처리시킨다.
 */
export class TossLookupError extends Error {
  readonly lookupFailed = true;
  constructor(message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "TossLookupError";
  }
}

function getSecretKey(): string {
  return process.env.TOSS_SECRET_KEY ?? "";
}

function getBasicAuthHeader(): string {
  // 시크릿 키 뒤에 콜론(:)을 붙이고 base64 인코딩 — 토스 Basic 인증 규약.
  return `Basic ${Buffer.from(`${getSecretKey()}:`).toString("base64")}`;
}

/** 시크릿 미설정(데모/E2E) 또는 mock paymentKey → 실 PG 승인 없이 처리. */
function isMock(paymentKey?: string): boolean {
  return !getSecretKey() || (paymentKey?.startsWith("mock_") ?? false);
}

/** 실 PG(토스) 시크릿 설정 여부 — 웹훅 조회검증 활성 판단. */
export function isTossSecretConfigured(): boolean {
  return Boolean(getSecretKey());
}

/**
 * 웹훅 검증용 — orderId 로 실제 결제를 조회한다(정본은 토스 서버).
 * 토스 웹훅은 HMAC 서명이 없어, 조회 API 재호출로 위조 웹훅을 차단한다.
 * 조회 실패/미설정 시 null.
 */
export async function getTossPaymentByOrderId(
  orderId: string,
): Promise<Record<string, unknown> | null> {
  return getTossPayment(`/payments/orders/${encodeURIComponent(orderId)}`);
}

/** Payment-key lookup used after a cancel response loss. */
export async function getTossPaymentByPaymentKey(
  paymentKey: string,
): Promise<Record<string, unknown> | null> {
  return getTossPayment(`/payments/${encodeURIComponent(paymentKey)}`);
}

async function getTossPayment(path: string): Promise<Record<string, unknown> | null> {
  if (!getSecretKey()) return null; // mock/dev — 조회 불가(실 웹훅도 발생하지 않음)
  let response: Response;
  try {
    response = await fetch(`${TOSS_API_URL}${path}`, {
      headers: { Authorization: getBasicAuthHeader() },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    // 네트워크·타임아웃 = 조회 실패(fail-closed). "결제 없음"이 아니다.
    throw new TossLookupError(
      `Toss 조회 네트워크 오류: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (response.status === 404) return null; // 결제 없음(정상 — 미캡처/미존재)
  if (!response.ok) {
    // 401·5xx = 조회 실패(fail-closed). null 로 뭉개면 orphan scanner 가 정상 pending 위장.
    throw new TossLookupError(`Toss 조회 실패 HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as Record<string, unknown>;
}

export const tossProvider: PaymentProvider = {
  async prepare(params) {
    // V2 결제창은 클라 SDK 가 직접 결제창을 띄우므로 서버 prepare 는 불필요.
    // PaymentProvider 인터페이스 호환용 no-op.
    return {
      redirectUrl: `${params.successUrl}?orderId=${params.orderId}`,
      paymentKey: params.orderId,
    };
  },

  async confirm(params): Promise<PaymentResult> {
    // mock 모드: 실 PG 승인 없이 성공 처리 → 로컬 E2E/데모 호환.
    if (isMock(params.paymentKey)) {
      return {
        success: true,
        paymentKey: params.paymentKey,
        method: "toss",
        approvedAt: new Date().toISOString(),
      };
    }

    const response = await fetch(`${TOSS_API_URL}/payments/confirm`, {
      method: "POST",
      headers: {
        Authorization: getBasicAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentKey: params.paymentKey,
        orderId: params.orderId,
        amount: params.amount,
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      // 재시도 멱등: 이전 confirm 이 PG 승인 후 응답 유실된 경우 재호출은 ALREADY_PROCESSED 로 온다.
      // 결제 조회로 동일 주문·금액·DONE 을 검증한 뒤 성공으로 취급 — 아니면 그대로 실패.
      if (payload.code === "ALREADY_PROCESSED_PAYMENT") {
        const lookup = await fetch(`${TOSS_API_URL}/payments/${encodeURIComponent(params.paymentKey)}`, {
          headers: { Authorization: getBasicAuthHeader() },
        });
        const existing = (await lookup.json()) as Record<string, unknown>;
        if (
          lookup.ok &&
          String(existing.orderId ?? "") === params.orderId &&
          String(existing.status ?? "") === "DONE" &&
          Number(existing.totalAmount ?? -1) === params.amount
        ) {
          const receiptExisting = existing.receipt;
          return {
            success: true,
            paymentKey: String(existing.paymentKey ?? params.paymentKey),
            method: String(existing.method ?? "toss"),
            approvedAt: String(existing.approvedAt ?? new Date().toISOString()),
            receipt:
              typeof receiptExisting === "object" && receiptExisting !== null
                ? String((receiptExisting as Record<string, unknown>).url ?? "")
                : undefined,
          };
        }
      }
      const message =
        typeof payload.message === "string" ? payload.message : "토스 결제 승인에 실패했습니다";
      throw new Error(message);
    }

    const status = String(payload.status ?? "");
    // 가상계좌: 발급 완료·입금 대기 → pending. 실입금은 DEPOSIT_CALLBACK 웹훅에서 확정.
    const pending = status === "WAITING_FOR_DEPOSIT";
    const receiptObj = payload.receipt;

    return {
      success: !pending,
      pending,
      paymentKey: String(payload.paymentKey ?? params.paymentKey),
      method: String(payload.method ?? "toss"),
      approvedAt: String(payload.approvedAt ?? new Date().toISOString()),
      receipt:
        typeof receiptObj === "object" && receiptObj !== null
          ? String((receiptObj as Record<string, unknown>).url ?? "")
          : undefined,
    };
  },

  async cancel(params): Promise<CancelResult> {
    if (isMock(params.paymentKey)) {
      return {
        success: true,
        cancelAmount: params.amount ?? 0,
        cancelledAt: new Date().toISOString(),
      };
    }

    let response: Response;
    try {
      response = await fetch(`${TOSS_API_URL}/payments/${encodeURIComponent(params.paymentKey)}/cancel`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(),
          "Content-Type": "application/json",
          // 네트워크 재시도 시 중복취소 방지.
          "Idempotency-Key": `cancel:${params.paymentKey}`,
        },
        body: JSON.stringify({
          cancelReason: params.reason,
          ...(params.amount != null ? { cancelAmount: params.amount } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new TossAmbiguousError(
        `토스 취소 요청 응답 유실: ${error instanceof Error ? error.message : String(error)}`,
        params.paymentKey,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      if (response.status >= 500) {
        throw new TossAmbiguousError("토스 취소 provider 응답 불명확", params.paymentKey, response.status);
      }
      const message =
        typeof payload.message === "string" ? payload.message : "토스 결제 취소에 실패했습니다";
      throw new Error(message);
    }

    // 부분/전체 취소 금액·시각은 cancels 배열 최신 항목에 있음(best-effort).
    const cancels = Array.isArray(payload.cancels) ? payload.cancels : [];
    const lastCancel =
      cancels.length > 0 ? (cancels[cancels.length - 1] as Record<string, unknown>) : {};
    return {
      success: true,
      cancelAmount: Number(lastCancel.cancelAmount ?? params.amount ?? 0),
      cancelledAt: String(lastCancel.canceledAt ?? new Date().toISOString()),
    };
  },
};
