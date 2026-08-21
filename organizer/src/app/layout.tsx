import type { Metadata, Viewport } from "next";
import { SITE_NAME, TITLE_TEMPLATE } from "@/lib/seo/site";
import localFont from "next/font/local";
import { Toaster } from "@/components/shared/toaster";
import "./globals.css";

// 모바일 최적화 — device-width + viewport-fit=cover 로 노치기기 safe-area-inset 활성화
// (하단 sticky CTA/모바일 네비가 env(safe-area-inset-bottom) 을 쓰는데 cover 없이는 inset=0).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const pretendard = localFont({
  src: [
    {
      path: "../../public/fonts/PretendardVariable.woff2",
      style: "normal",
      weight: "100 900",
    },
  ],
  display: "swap",
  variable: "--font-pretendard",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3004"),
  title: {
    default: `${SITE_NAME} — 이벤트를 여는 모든 사람을 위해`,
    // 자식 페이지가 준 평문 `title` 뒤에 브랜드를 붙인다.
    // 🔴 그래서 자식은 브랜드를 쓰면 안 된다 — 쓰면 두 번 붙는다(`lib/seo/site.ts`).
    template: TITLE_TEMPLATE,
  },
  description:
    "강연, 세미나, 컨퍼런스, 축제, 팝업, 동호회 모임까지. 규모·분야·유료무료 상관없이 AI가 5분에 이벤트를 만들고, 결제·체크인·정산까지 하나의 도구로. 디자이너·개발자·회계사 없이도 됩니다.",
  keywords: [
    "이벤트 티켓팅",
    "이벤트 플랫폼",
    "AI 이벤트",
    "컨퍼런스 티켓",
    "세미나 운영",
    "축제 티켓",
    "MICE",
    "팝업 이벤트",
    "RSVP",
    "피켓",
  ],
  openGraph: {
    title: "PICKKET.GO — 이벤트를 여는 모든 사람을 위해",
    description:
      "강연자도, 지자체도, MICE 기획사도. 누구든 5분 만에 이벤트를 엽니다. AI가 만들고, 당신은 행사에 집중하세요.",
    type: "website",
    locale: "ko_KR",
    siteName: "PICKKET.GO",
  },
  twitter: {
    card: "summary_large_image",
    title: "PICKKET.GO — 이벤트를 여는 모든 사람을 위해",
    description: "만들고, 팔고, 운영하세요. 하나의 도구로.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${pretendard.variable} min-h-screen overflow-x-hidden break-keep bg-background text-foreground antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
