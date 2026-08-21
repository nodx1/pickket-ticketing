import type { Metadata } from "next";
import { BASE_URL } from "@pickket/lib";
import "@pickket/tailwind-config/globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "Pickket — Fair Ticket Allocation",
    template: "%s | Pickket",
  },
  description:
    "Fair ticket allocation platform powered by AI. No queues, no bots, fair prices for true fans.",
  openGraph: {
    type: "website",
    siteName: "Pickket",
    title: "Pickket — Fair Ticket Allocation",
    description:
      "특허 기반 공정 티켓 배분 플랫폼. 공정 추첨으로 진짜 팬에게 공정한 기회를.",
    url: BASE_URL,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Pickket - Fair Ticket Allocation Platform",
      },
    ],
    locale: "ko_KR",
    alternateLocale: ["en_US", "ja_JP", "zh_CN", "fr_FR"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pickket — Fair Ticket Allocation",
    description:
      "특허 기반 공정 티켓 배분 플랫폼. 공정 추첨으로 진짜 팬에게 공정한 기회를.",
    images: ["/og-image.png"],
  },
};

// Root layout delegates <html>/<body> to [locale]/layout.tsx
// so that <html lang={locale}> can be set dynamically per locale
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
