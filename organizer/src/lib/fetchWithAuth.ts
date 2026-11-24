import { NOT_ORGANIZER_CODE, NOT_ORGANIZER_LOGIN_PATH } from "@/lib/auth/not-organizer";

type FetchWithAuthOptions = RequestInit & {
  redirectOnUnauthorized?: boolean;
};

interface ApiErrorPayload {
  success?: boolean;
  error?: string;
  code?: string;
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * access 토큰이 401 받으면 한 번에 한해서 /api/auth/refresh 호출 후 재시도.
 * 동시 다중 요청 시 refresh 중복 호출 방지 (Promise singleton).
 *
 * 🔴 **직접 `fetch("/api/auth/refresh")` 를 부르지 말고 이걸 쓴다.**
 *    v2 는 갱신할 때마다 refresh 토큰을 **회전**시킨다(`auth.py:_set_refresh_cookie`).
 *    동시에 두 번 부르면 뒤엣것이 낡은 토큰을 들고 가 **반드시 401** 이 난다.
 *    아래 500ms 싱글턴이 그걸 막는다 — 우회하면 보호가 사라진다.
 *    (실측 2026-07-31: 우회 호출로 401 을 한 번 받았다)
 */
export async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        // refresh 끝나면 다음 401 때 다시 시도 가능하게
        setTimeout(() => {
          refreshPromise = null;
        }, 500);
      });
  }
  return refreshPromise;
}

async function doFetch(
  input: RequestInfo | URL,
  init?: FetchWithAuthOptions,
): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * 갱신만 하고 **Response 를 그대로** 돌려준다 (2026-07-31 실사고).
 *
 * ## 🔴 왜 필요한가
 * access 쿠키는 **5분**이다(`config.py:ACCESS_TOKEN_EXPIRE_MINUTES=5` → `auth.py` 가
 * `max_age=300` 으로 굽는다). 5분이 지나면 **브라우저가 쿠키를 지운다.** 그런데
 * `pickket_refresh`(7일)·`pickket_logged_in`(7일)은 남아 있어 **화면은 로그인 상태로 보인다.**
 * 이미 그려진 대시보드는 재검증하지 않으므로(서버 렌더가 다시 돌지 않는다) 사용자는
 * 계속 입력하다가 **저장할 때 처음** "로그인이 필요합니다" 를 만난다 — 그 시점엔 이미
 * 편집 내용이 날아간 뒤다. 실제로 대표가 이렇게 잃었다.
 *
 * refresh 경로는 **멀쩡하다**(v2 CSRF 면제, 7일 유효). 문제는 **불리지 않는 것**이었다 —
 * 갱신 트리거가 `fetchWithAuth` 하나뿐인데 대시보드 쓰기 대부분이 생짜 `fetch` 였다.
 *
 * ## 왜 `fetchWithAuth` 로 다 바꾸지 않는가
 * `fetchWithAuth` 는 `Content-Type: application/json` 을 **강제**하고 응답을 JSON 으로
 * 파싱한다. 그래서 두 경우를 깨뜨린다:
 *   · `FormData` 업로드 — Content-Type 을 브라우저가 boundary 와 함께 정해야 한다
 *   · CSV·파일 다운로드 — 응답이 JSON 이 아니다
 * ⟹ 그런 자리는 이 함수를 쓴다. **갱신은 똑같이 걸리고**, 응답 처리는 호출부가 한다.
 *
 * ## 🔴 `init` 을 함수로도 받는 이유 — 쿠키에서 파생된 헤더 (2026-07-31)
 * 종전엔 `init` 객체를 받아 재시도 때 **그대로 다시** 보냈다. 헤더가 요청마다 고정이라는
 * 전제였는데, **갱신이 `pickket_csrf` 도 새로 발급**한다(실측: refresh 응답의 Set-Cookie 에
 * access·refresh·logged_in·csrf 넷이 함께 온다). 그래서 CSRF 를 쿠키에서 읽어 헤더에 싣는
 * 호출은 **낡은 토큰으로 재시도**돼 401 이 403 으로 바뀔 뿐이었다(체크인 화면이 그 자리다).
 *
 * ⟹ `init` 에 **함수**를 주면 재시도 직전에 다시 만든다. 쿠키 파생 헤더가 앞으로 더 생겨도
 *    같은 함정을 안 밟는다. 객체를 주는 기존 호출부는 그대로 동작한다.
 */
export async function fetchWithRefresh(
  input: RequestInfo | URL,
  init?: RequestInit | (() => RequestInit),
): Promise<Response> {
  // 매 시도마다 새로 만든다 — 함수면 호출, 객체면 그대로.
  const send = () =>
    fetch(input, { ...(typeof init === "function" ? init() : init), credentials: "include" });

  let response = await send();
  if (response.status !== 401) return response;

  const refreshed = await tryRefresh();
  if (refreshed) response = await send();
  return response;
}

export async function fetchWithAuth<T>(
  input: RequestInfo | URL,
  init?: FetchWithAuthOptions,
): Promise<T> {
  let response = await doFetch(input, init);

  // 401 + refresh 가능 → 한 번 갱신 시도 후 재호출
  if (response.status === 401 && init?.redirectOnUnauthorized !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      response = await doFetch(input, init);
    }
    // 재시도 후에도 401 이면 로그인 화면으로
    if (response.status === 401) {
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("로그인이 필요합니다");
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as T | ApiErrorPayload)
    : null;

  if (!response.ok) {
    // 주최사가 아닌 계정(피켓 팬 로그인 공유) — 로그인 화면에서 주최사 계정으로 바꾸게 한다.
    if (
      response.status === 403 &&
      payload &&
      typeof payload === "object" &&
      "code" in payload &&
      payload.code === NOT_ORGANIZER_CODE &&
      typeof window !== "undefined"
    ) {
      window.location.href = NOT_ORGANIZER_LOGIN_PATH;
    }
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "요청 처리에 실패했습니다";
    throw new Error(message);
  }

  return payload as T;
}
