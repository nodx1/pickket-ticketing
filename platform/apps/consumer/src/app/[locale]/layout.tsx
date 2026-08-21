import type { Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@pickket/ui";
import { API_URL, CDN_URL } from "@pickket/lib";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import ClientLayout from "@/components/common/ClientLayout";
import { WebVitalsReporter } from "@pickket/lib";
import { OrganizationJsonLd } from "@/components/seo/JsonLd";
import { QueryProvider } from "@/providers/QueryProvider";
import { AuthProvider } from "@/providers/AuthProvider";
import { BehaviorTokenProvider } from "@/providers/BehaviorTokenProvider";
import { routing } from "@/i18n/routing";

const pretendard = localFont({
  src: [
    {
      path: "../../../public/fonts/PretendardVariable-latin.woff2",
      style: "normal",
      weight: "100 900",
    },
    {
      path: "../../../public/fonts/PretendardVariable-korean.woff2",
      style: "normal",
      weight: "100 900",
    },
  ],
  variable: "--font-pretendard",
  display: "swap",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// 모바일 최적화 — device-width + viewport-fit=cover 로 노치기기 safe-area-inset 활성화
// (하단 sticky CTA/채팅 FAB 가 env(safe-area-inset-bottom) 을 쓰는데 cover 없이는 inset=0).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  setRequestLocale(locale);
  const messages = await getMessages();
  const t = await getTranslations("common.layout");

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Resource Hints — preconnect to API & CDN for faster first requests */}
        <link rel="preconnect" href={API_URL} crossOrigin="anonymous" />
        {CDN_URL && (
          <link rel="preconnect" href={CDN_URL} crossOrigin="anonymous" />
        )}
        <link rel="manifest" href="/manifest.json" />
        {/* SW cleanup disabled during dev — causes reload loop with HMR */}
        {/* <script src="/sw-cleanup.js" async /> */}
        <meta name="theme-color" content="#6366f1" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Pickket" />
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
      </head>
      <body className={`${pretendard.variable} font-sans antialiased`}>
        <a
          href="#main-content"
          tabIndex={0}
          data-skip-link="true"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-black focus:shadow-lg"
        >
          {t("skipToMain")}
        </a>
        <WebVitalsReporter />
        <OrganizationJsonLd nonce={nonce} />
        <NextIntlClientProvider messages={messages}>
          <QueryProvider>
            {/* forcedTheme="light" locks the consumer app to light mode.
                ~80+ files still contain dark:* Tailwind classes — these are inactive
                (Tailwind only applies them when a "dark" class is on <html>).
                They add ~0 runtime cost but inflate CSS bundle slightly.
                TODO: bulk-remove dark:* classes once dark mode is confirmed out of scope. */}
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              forcedTheme="light"
              disableTransitionOnChange
              nonce={nonce}
            >
              <TooltipProvider>
                <ErrorBoundary>
                  <AuthProvider>
                    <BehaviorTokenProvider>
                      <ClientLayout>{children}</ClientLayout>
                    </BehaviorTokenProvider>
                  </AuthProvider>
                </ErrorBoundary>
              </TooltipProvider>
            </ThemeProvider>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
