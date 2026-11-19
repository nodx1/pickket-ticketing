import { routing } from "@/i18n/routing";

/**
 * 세션이 만료됐을 때(401·refresh 실패) 로그인 화면으로 보낼 화면인지.
 *
 * 공개 화면(홈·이벤트·공정성 증명서 등)에서는 로그인 화면으로 튕기지 않고 조용히 로그아웃만 한다.
 * 홈 화면 앱(PWA)을 며칠 만에 열면 남아 있던 로그인 정보가 만료돼 있는데, 그때 첫 화면이
 * 로그인으로 바뀌면 둘러보지도 못한다. 로그인이 꼭 필요한 화면만 로그인으로 보낸다.
 */
const LOGIN_REQUIRED = [
  /^\/mypage(\/|$)/,
  /^\/orders(\/|$)/,
  /^\/tickets(\/|$)/,
  /^\/notifications(\/|$)/,
  /^\/points(\/|$)/,
  /^\/payment(\/|$)/,
  /^\/fanclub\/manage(\/|$)/,
  /^\/events\/create(\/|$)/,
  /^\/events\/[^/]+\/edit(\/|$)/,
  /^\/staff(\/|$)/,
];

export function stripLocale(pathname: string): string {
  const seg = pathname.split("/")[1];
  if ((routing.locales as readonly string[]).includes(seg)) {
    return pathname.slice(seg.length + 1) || "/";
  }
  return pathname || "/";
}

export function needsLoginRedirect(pathname: string): boolean {
  const path = stripLocale(pathname);
  return LOGIN_REQUIRED.some((re) => re.test(path));
}
