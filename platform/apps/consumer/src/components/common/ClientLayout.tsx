"use client";

import { usePathname } from "next/navigation";
import { LazyMotion, MotionConfig } from "motion/react";
import { Toaster, OfflineBanner } from "@pickket/ui";
import Header from "./Header";
import Footer from "./Footer";
import ScrollProgress from "./ScrollProgress";
import PageTransition from "./PageTransition";
import PaymentReminderBanner from "./payment/PaymentReminderBanner";
import CookieBanner from "./consent/CookieBanner";
import PolicyUpdateBanner from "./legal/PolicyUpdateBanner";
import { routing } from "@/i18n/routing";
import { PwaProvider } from "@/components/pwa/PwaProvider";
import { InstallBanner } from "@/components/pwa/InstallBanner";

// 모바일 「홈 화면에 추가」 배너를 띄우는 화면 — 하단 고정 버튼(응모·결제)이 있는 화면은 제외.
const INSTALL_BANNER_PATHS = new Set(["/", "/events", "/mypage"]);

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const KNOWN_LOCALES = routing.locales;
  const segments = pathname.split("/");
  const hasLocalePrefix = (KNOWN_LOCALES as readonly string[]).includes(
    segments[1],
  );
  const canonicalPath = hasLocalePrefix
    ? "/" + segments.slice(2).join("/") || "/"
    : pathname;

  const isFocusFlow =
    canonicalPath.startsWith("/auth") ||
    canonicalPath.startsWith("/onboarding");
  const isCheckoutFlow =
    canonicalPath.startsWith("/orders") ||
    canonicalPath.startsWith("/tickets") ||
    canonicalPath.startsWith("/resale") ||
    /^\/events\/[^/]+\/booking/.test(canonicalPath);
  const isHome = canonicalPath === "/";
  const _isEventDetail = /^\/events\/[^/]+$/.test(canonicalPath) || false;
  const isImmersive = isHome;
  const isBooking = /^\/events\/[^/]+\/booking/.test(canonicalPath);

  const loadFeatures = () =>
    import("@/lib/motion-features").then((m) => m.default);

  return (
    <LazyMotion features={loadFeatures} strict={false}>
      <MotionConfig reducedMotion="user">
        {/* overflow-hidden은 booking 페이지 내부(BookingPageClient)에서 자체 처리
            — <main>에 overflow-hidden을 걸면 Radix Dialog Portal이 잘리는 문제 발생 */}
        {!isBooking && <OfflineBanner />}
        {!isFocusFlow && !isImmersive && !isBooking && <ScrollProgress />}
        {!isFocusFlow && !isBooking && (
          <Header variant={isImmersive ? "transparent" : "default"} />
        )}
        {!isFocusFlow && !isCheckoutFlow && !isImmersive && !isBooking && (
          <PaymentReminderBanner />
        )}
        {!isFocusFlow && !isImmersive && !isBooking && <PolicyUpdateBanner />}
        <main
          id="main-content"
          className={isBooking ? "h-screen" : "min-h-screen"}
        >
          {isImmersive || isBooking ? (
            children
          ) : (
            <PageTransition>{children}</PageTransition>
          )}
        </main>
        {!isFocusFlow && !isCheckoutFlow && !isBooking && <Footer />}
        {!isBooking && <CookieBanner />}
        <PwaProvider />
        {INSTALL_BANNER_PATHS.has(canonicalPath) && <InstallBanner />}
        <Toaster position="bottom-right" richColors />
      </MotionConfig>
    </LazyMotion>
  );
}
