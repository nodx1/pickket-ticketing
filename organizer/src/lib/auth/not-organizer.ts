/**
 * 주최사가 아닌 계정으로 피켓고에 들어왔을 때의 안내 — 서버(withAuth·로그인 라우트)와
 * 화면(fetchWithAuth·로그인 화면)이 같은 값을 쓴다. 클라이언트에서도 읽으므로 서버 전용
 * 모듈(node:crypto 등)을 import 하지 않는다.
 */
export const NOT_ORGANIZER_CODE = "NOT_ORGANIZER";

export const NOT_ORGANIZER_MESSAGE =
  "주최사 계정이 아닌 계정(피켓 팬 계정 등)으로 로그인되어 있어요. 피켓고는 주최사 계정으로 로그인해 주세요.";

/** 로그인 폼에 주최사가 아닌 계정을 넣었을 때 — 세션은 만들지 않는다. */
export const NOT_ORGANIZER_LOGIN_MESSAGE =
  "주최사 계정이 아니에요. 피켓고는 주최사 계정으로만 로그인할 수 있어요.";

/** 로그인 화면 주소 — `reason` 을 보고 위 안내를 띄운다. */
export const NOT_ORGANIZER_LOGIN_PATH = "/login?reason=not_organizer";
