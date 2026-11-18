import { routing } from "@/i18n/routing";

/**
 * 지금 주소에서 언어를 읽는다 — 결제 성공·실패로 돌아올 주소를 만들 때 쓴다.
 *
 * 🔴 기본 언어(ko)는 주소에 언어 칸이 없다(localePrefix: "as-needed"). 예전엔 주소 첫 칸을
 *    무조건 언어로 읽어 `/orders/…` 에서 결제하면 `/orders/payment/success` 로 돌아와 404 가 났다
 *    (실측 2026-11-18: 당첨자 결제 직후). 언어 목록에 있는 값일 때만 언어로 인정한다.
 */
export function localeFromPath(pathname: string | null | undefined): string {
  const seg = (pathname ?? "").split("/")[1] ?? "";
  return (routing.locales as readonly string[]).includes(seg) ? seg : routing.defaultLocale;
}

/** 브라우저 현재 주소 기준(서버 렌더 중이면 기본 언어). */
export function currentLocale(): string {
  return localeFromPath(typeof window !== "undefined" ? window.location.pathname : null);
}
