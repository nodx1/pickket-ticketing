import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import AsyncStorage from "@react-native-async-storage/async-storage";

import ko from "./locales/ko.json";
import en from "./locales/en.json";

const deviceLanguage = getLocales()[0]?.languageCode ?? "ko";
const initialLng = deviceLanguage === "ko" ? "ko" : "en";

i18n.use(initReactI18next).init({
  resources: {
    ko: { translation: ko },
    en: { translation: en },
  },
  lng: initialLng,
  // AUDIT 2026-04-20 §8 P1: 개발 중 누락 키가 보이도록 fallback 비활성
  fallbackLng: false,
  interpolation: {
    escapeValue: false,
  },
});

// AUDIT 2026-04-20 §8 P0: 유저가 고른 언어가 앱 재시작 후에도 유지되도록 AsyncStorage에서 하이드레이션
AsyncStorage.getItem("user_language")
  .then((saved) => {
    if (saved && saved !== i18n.language) {
      void i18n.changeLanguage(saved);
    }
  })
  .catch(() => {
    /* best-effort — storage 오류 시 디바이스 로케일 유지 */
  });

export default i18n;
