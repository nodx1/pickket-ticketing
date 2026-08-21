import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ko", "en", "ja", "zh-CN", "fr", "ru", "vi"],
  defaultLocale: "ko",
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});
