import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

/**
 * 로케일 메시지를 로드하되, **en 을 기저로 target 로케일을 덮어쓴다**(깊은 병합).
 * 신규 키(예: 나이스 결제수단 라벨·안내)를 ko/en 에만 추가해도, 나머지 로케일은
 * 해당 키에 대해 자동으로 en 값을 폴백으로 노출한다(키 경로 노출·누락 방지).
 * en 자신은 자기 자신과 병합(no-op).
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(
        prev as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  const supportedLocales: readonly string[] = routing.locales;

  if (!locale || !supportedLocales.includes(locale)) {
    locale = routing.defaultLocale;
  }

  const localeMessages = (await import(`../../messages/${locale}.json`)).default;

  // 영어를 기저 폴백으로 깊은 병합(en 이면 자기 자신 — 실질 no-op).
  const messages =
    locale === "en"
      ? localeMessages
      : deepMerge(
          (await import(`../../messages/en.json`)).default,
          localeMessages,
        );

  return {
    locale,
    messages,
  };
});
