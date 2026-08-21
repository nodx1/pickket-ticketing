// vitest 환경용 next-intl stub
// next-intl은 NextIntlClientProvider 컨텍스트가 필요하지만, vitest에서는 stub으로 처리

type TranslationFn = (key: string, values?: Record<string, unknown>) => string;

/**
 * useTranslations — 키를 그대로 반환하는 stub
 * 테스트에서 번역된 UI 문자열이 아닌 번역 키로 assertion할 때 사용
 */
export function useTranslations(_namespace?: string): TranslationFn {
  return (key: string) => key;
}

export function useLocale(): string {
  return "ko";
}

export function useMessages(): Record<string, unknown> {
  return {};
}

export function useFormatter() {
  return {
    dateTime: (date: Date | number) => String(date),
    number: (n: number) => String(n),
    list: (items: unknown[]) => items.join(", "),
    relativeTime: (value: number) => String(value),
  };
}

export function useNow() {
  return new Date();
}

export function useTimeZone(): string {
  return "Asia/Seoul";
}

export function NextIntlClientProvider({
  children,
}: {
  children: React.ReactNode;
  [key: string]: unknown;
}) {
  return children as React.ReactElement;
}

export function getTranslations(_namespace?: string) {
  return async () => (key: string) => key;
}

export function getLocale() {
  return Promise.resolve("ko");
}

export function getMessages() {
  return Promise.resolve({});
}
