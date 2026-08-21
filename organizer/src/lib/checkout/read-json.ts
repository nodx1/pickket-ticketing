/**
 * 체크아웃 응답 파싱 — **JSON 이 아닌 응답을 진단 가능한 오류로 바꾼다.**
 *
 * ## 🔴 왜 필요한가 (2026-07-30)
 * 결제 화면이 구매자에게 이 문구를 그대로 보여줬다:
 *
 *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * 원인은 `await res.json()` 을 **무조건** 호출한 것이다. 응답이 HTML(프록시/CDN 오류
 * 페이지, Next 500 페이지 등)이면 파서가 저 메시지로 터지고, 그게 그대로 화면에 뜬다.
 *
 * ⚠️ **나는 이 사례의 원인을 특정하지 못했다.** 클린 세션에서 재현되지 않았고,
 *    후보 경로를 전부 확인했지만 모두 JSON 이었다:
 *      · `/api/checkout/initiate` — CARD·VBANK 둘 다 201 `application/json`
 *      · `/api/checkout/complete` — 400 `application/json`
 *      · 레이트리밋 초과(10회/분) — 429 `application/json`
 *    남는 후보는 **CDN/프록시가 브라우저에 직접 낸 HTML**(봇 챌린지·5xx 페이지)이며,
 *    그건 서버 로그에 안 남고 재현 조건도 알 수 없다.
 *
 * ⟹ 원인을 못 찾았으므로 **다음 발생 때 스스로 말하게** 만든다. 상태코드와 응답
 *   앞부분을 남기고, 구매자에게는 조치 가능한 문구를 보여준다.
 *   원인 추정으로 코드를 고치는 것보다 이게 정직하다.
 */

/** JSON 이 아닌 응답을 만났을 때의 오류 — 상태코드를 보존해 원인 분류에 쓴다. */
export class NonJsonResponseError extends Error {
  constructor(
    readonly status: number,
    readonly contentType: string,
    readonly bodyHead: string,
    message: string,
  ) {
    super(message);
    this.name = "NonJsonResponseError";
  }
}

/** 구매자에게 보여줄 문구 — 상태코드별로 조치가 다르다. */
function userMessage(status: number): string {
  if (status === 429) return "요청이 많아 잠시 지연되고 있습니다. 30초 후 다시 시도해주세요.";
  if (status === 403 || status === 503) {
    // CDN 봇 차단·점검 페이지가 이 자리에 온다.
    return "결제 요청이 차단되었습니다. 새로고침 후 다시 시도하거나 다른 브라우저로 시도해주세요.";
  }
  if (status >= 500) return "결제 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.";
  return "결제 요청 처리 중 문제가 발생했습니다. 새로고침 후 다시 시도해주세요.";
}

/**
 * 응답을 JSON 으로 읽는다. JSON 이 아니면 `NonJsonResponseError` 를 던진다.
 *
 * @param res   fetch 응답
 * @param label 어느 호출인지(오류 문구·로그에 포함) — 예: `"checkout/initiate"`
 *
 * 🔴 `res.json()` 을 직접 부르지 말 것. 이 함수를 쓰는 이유가 위 주석이다.
 */
export async function readCheckoutJson<T>(res: Response, label: string): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const raw = await res.text().catch(() => "");
    // 응답 앞부분만 남긴다 — 전체를 남기면 HTML 한 장이 로그·화면에 쏟아진다.
    const bodyHead = raw.slice(0, 200).replace(/\s+/g, " ").trim();
    // 🔴 진단 정보는 콘솔로 남긴다(구매자 화면에는 상태코드까지만).
    console.error(
      `[checkout] ${label} 가 JSON 이 아닌 응답을 반환했다`,
      { status: res.status, contentType, bodyHead },
    );
    throw new NonJsonResponseError(
      res.status,
      contentType,
      bodyHead,
      // 상태코드를 문구에 넣는다 — 구매자가 알려주면 그것만으로 원인이 좁혀진다.
      `${userMessage(res.status)} (오류 ${res.status})`,
    );
  }
  // content-type 이 json 인데도 본문이 깨진 경우(잘린 응답 등)도 같은 형태로 다룬다.
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const bodyHead = raw.slice(0, 200).replace(/\s+/g, " ").trim();
    console.error(`[checkout] ${label} 의 JSON 본문이 손상됐다`, { status: res.status, bodyHead });
    throw new NonJsonResponseError(
      res.status,
      contentType,
      bodyHead,
      `결제 응답을 읽지 못했습니다. 잠시 후 다시 시도해주세요. (오류 ${res.status})`,
    );
  }
}
