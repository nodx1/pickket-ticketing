import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import koMessages from "../messages/ko.json";

// i18n 전면 배선 후, useTranslations 를 쓰는 컴포넌트가 테스트에서 NextIntlClientProvider
// 컨텍스트 없이 렌더되면 throw 한다. 실제 ko.json 메시지로 next-intl 을 글로벌 모킹해
// t() 가 진짜 한국어를 반환하도록 한다(한국어 텍스트 단언 테스트도 통과). 개별 테스트가
// 자체 vi.mock("next-intl") 을 두면 그 파일에선 로컬 모킹이 우선한다.
function resolveMessage(namespace: string, key: string): string | null {
  const path = namespace ? `${namespace}.${key}` : key;
  let node: unknown = koMessages;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

function makeT(namespace = "") {
  const t = (key: string, values?: Record<string, unknown>) => {
    let s = resolveMessage(namespace, key);
    if (s === null) return namespace ? `${namespace}.${key}` : key;
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        s = s.split(`{${k}}`).join(String(v));
      }
    }
    return s;
  };
  t.rich = (key: string) => resolveMessage(namespace, key) ?? key;
  t.markup = (key: string) => resolveMessage(namespace, key) ?? key;
  t.raw = (key: string) => resolveMessage(namespace, key);
  t.has = (key: string) => resolveMessage(namespace, key) !== null;
  return t;
}

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTranslations: (namespace?: string) => makeT(namespace),
    useFormatter: () => ({
      dateTime: (d: unknown) => String(d),
      number: (n: unknown) => String(n),
      relativeTime: (d: unknown) => String(d),
      list: (l: unknown) => String(l),
    }),
    useLocale: () => "ko",
    useMessages: () => koMessages,
    useNow: () => new Date(0),
    useTimeZone: () => "Asia/Seoul",
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

vi.mock("next-intl/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTranslations: async (arg?: string | { namespace?: string }) =>
      makeT(typeof arg === "string" ? arg : arg?.namespace),
    getLocale: async () => "ko",
    getMessages: async () => koMessages,
    getFormatter: async () => ({
      dateTime: (d: unknown) => String(d),
      number: (n: unknown) => String(n),
    }),
  };
});
