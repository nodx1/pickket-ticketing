import { V2CommerceError } from "@/lib/v2/commerce-client";

/**
 * v2 오류 봉투에서 **코드**를 꺼낸다.
 *
 * 🔴 `body` 는 **던지는 자리마다 모양이 다르다**(2026-08-09 실장애로 확인):
 *
 * ```
 * commerce-client.ts:146  HTTP 200 + {ok:false}  body = JSON.stringify(env.error)
 *                                                 → {code, message, field}      평면
 * commerce-client.ts:158  HTTP 4xx/5xx           body = 응답 원문
 *                                                 → {ok:false, error:{code,…}}  중첩
 * ```
 *
 * 종전 구현은 **평면만** 읽었다. v2 가 409 를 내면 `:158` 로 가므로 중첩이 오고,
 * `ORDER_NOT_REPLAYABLE` 분기가 통째로 죽어 **만료 토큰 자동복구가 안 돌았다**
 * (손님 화면에 기계 코드가 그대로 노출됐다).
 *
 * ⚠️ 그러니 **둘 다 받는다.** 이건 "관대함" 이 아니라 두 경로가 실재한다는 사실이다 —
 *    한쪽만 받으면 상태코드에 따라 조용히 죽는다.
 */
export function v2ErrorCode(err: unknown): string | null {
  // 🔴 `unknown` 을 받는다 — 호출부는 catch 절의 값을 그대로 넘긴다. 좁은 타입만 받으면
  //    호출부가 캐스팅으로 우회하고, 그 순간 V2 가 아닌 오류도 코드로 읽히기 시작한다.
  if (!(err instanceof V2CommerceError) || !err.body) return null;
  try {
    const parsed = JSON.parse(err.body) as {
      code?: unknown;
      error?: { code?: unknown };
    };
    // 평면(`{code}`) 우선, 없으면 중첩(`{error:{code}}`).
    const code = parsed?.code ?? parsed?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * v2 오류 봉투에서 **details** 를 꺼낸다 — 기계가 읽을 부가 정보.
 *
 * 🔴 `v2ErrorCode` 와 **같은 규칙**으로 평면·중첩을 둘 다 받는다. 한쪽만 받으면
 *    상태코드에 따라 조용히 죽는다(2026-08-09 에 코드 쪽에서 실제로 그렇게 죽었다).
 *
 * ⚠️ 구버전 v2 는 이 필드를 안 준다 — 호출자는 **반드시 폴백을 둔다**.
 */
export function v2ErrorDetails(err: unknown): Record<string, unknown> | null {
  // 🔴 `instanceof` 를 쓰지 않는다 — `commerce-client` 가 이 모듈을 **재수출**해서
  //    (`commerce-client.ts:3651`) 순환이 있고, 모듈 인스턴스가 갈리면 클래스 동일성이
  //    깨진다. 실제로 그 상태에서 이 함수가 **조용히 null 을 돌려줬다**(2026-08-10).
  //    여기서 필요한 것은 클래스가 아니라 **`body` 문자열**이다 — 그것만 본다.
  //    (v2 가 아닌 오류는 애초에 `body` 를 갖지 않는다.)
  const body = (err as { body?: unknown } | null)?.body;
  if (typeof body !== "string" || !body) return null;
  try {
    const parsed = JSON.parse(body) as {
      details?: unknown;
      error?: { details?: unknown };
    };
    const d = parsed?.details ?? parsed?.error?.details;
    return d !== null && typeof d === "object" ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 재발송 409 를 주최자가 읽을 문장으로 옮긴다.
 *
 * 🔴 상태코드만 보면 안 된다. 재발송의 409 는 이제 두 가지다 —
 *    회수됨(INVITATION_REVOKED)과 발송 중(DISPATCH_IN_FLIGHT). 뭉뚱그리면
 *    멀쩡한 초대에 "회수된 초대" 라고 표시해 주최자가 없는 문제를 쫓는다.
 *
 * 모르는 코드는 **모른다고 한다.** 원인을 잘못 가리키는 쪽이 더 비싸다.
 */
export function resendConflictMessage(code: string | null): string {
  if (code === "DISPATCH_IN_FLIGHT") return "지금 발송 중입니다. 잠시 후 다시 시도해주세요.";
  if (code === "INVITATION_REVOKED") return "회수된 초대는 재발송할 수 없습니다";
  return "지금은 재발송할 수 없는 상태입니다";
}
