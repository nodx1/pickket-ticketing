import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { ThemeProvider } from "next-themes";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { TooltipProvider } from "@pickket/ui";
import { WebVitalsReporter } from "@pickket/lib";
import "./admin.css";

import AdminLayout from "@/components/AdminLayout";
import { InactivityWatcher } from "@/components/InactivityWatcher";

const pretendard = localFont({
  src: [
    { path: "../../public/fonts/PretendardVariable.woff2", style: "normal" },
  ],
  variable: "--font-pretendard",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Pickket Admin", template: "%s | Pickket Admin" },
  description: "관리자를 위한 운영 포탈",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const messages = await getMessages();
  const t = await getTranslations("common.layout");

  return (
    <html lang="ko" suppressHydrationWarning>
      <body className={`${pretendard.variable} font-sans antialiased`}>
        <WebVitalsReporter />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[200] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm focus:font-medium focus:shadow-lg"
        >
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            nonce={nonce}
          >
            <TooltipProvider>
              <InactivityWatcher />
              <AdminLayout>{children}</AdminLayout>
            </TooltipProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
