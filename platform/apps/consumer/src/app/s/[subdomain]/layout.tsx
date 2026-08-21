/**
 * Subdomain layout — renders event-specific branded pages.
 * URL: {slug}.pickket.kr → rewritten to /s/{slug}/... by middleware
 *
 * This is intentionally separate from [locale] layout:
 * - No next-intl locale prefix (subdomain pages are standalone)
 * - Event-specific branding (colors, logo from page_theme)
 * - Minimal shell (no main site nav/footer)
 */

import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { ThemeProvider } from "next-themes";
import { API_URL, CDN_URL } from "@pickket/lib";
import { QueryProvider } from "@/providers/QueryProvider";
import { themeToCSS } from "./_lib/theme";
import { getEvent } from "./_lib/get-event";
import { buildEventJsonLd } from "./_lib/json-ld";
import { serializeJsonLd } from "@/components/seo/JsonLd";
import { getSubdomainLocale } from "./_lib/subdomain-i18n";
import { SubdomainFooter } from "./_components/SubdomainFooter";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const event = await getEvent(subdomain);
  if (!event) return { title: "Not Found | Pickket" };

  const title = event.white_label ? event.title : `${event.title} | Pickket`;
  const description = event.description || "";
  const image = event.page_theme?.ogImage || event.image_url || "";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: image ? [{ url: image }] : [],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: image ? [image] : [],
    },
  };
}

const pretendard = localFont({
  src: [
    {
      path: "../../../../public/fonts/PretendardVariable-latin.woff2",
      style: "normal",
      weight: "100 900",
    },
    {
      path: "../../../../public/fonts/PretendardVariable-korean.woff2",
      style: "normal",
      weight: "100 900",
    },
  ],
  variable: "--font-pretendard",
  display: "swap",
});

export default async function SubdomainLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? undefined;
  const event = await getEvent(subdomain);

  // Detect language: ?lang= param → Accept-Language header → "ko"
  const url = headersList.get("x-url") || headersList.get("referer") || "";
  const searchParams = url.includes("?")
    ? new URLSearchParams(url.split("?")[1])
    : null;
  const acceptLanguage = headersList.get("accept-language");
  const locale = getSubdomainLocale(searchParams, acceptLanguage);

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href={API_URL} crossOrigin="anonymous" />
        {CDN_URL && (
          <link rel="preconnect" href={CDN_URL} crossOrigin="anonymous" />
        )}
        {event && (
          <script
            type="application/ld+json"
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: serializeJsonLd(buildEventJsonLd(event)),
            }}
          />
        )}
      </head>
      <body
        className={`${pretendard.variable} font-sans antialiased bg-background text-foreground`}
        style={themeToCSS(event?.page_theme)}
      >
        <QueryProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem={false}
            disableTransitionOnChange
            nonce={nonce}
          >
            {/* TODO: generateStaticParams — pre-render popular subdomains at build time
                when analytics data is available to determine high-traffic subdomains */}
            <div className="flex flex-col min-h-screen">
              {children}
              <SubdomainFooter
                whiteLabel={event?.white_label}
                config={event?.white_label_config}
              />
            </div>
          </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
