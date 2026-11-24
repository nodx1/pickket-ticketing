// Pickket Consumer — Next.js 16.1 + next-intl
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import bundleAnalyzer from "@next/bundle-analyzer";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const cdnUrl = process.env.CDN_URL || "";

const extraImageHosts = (process.env.NEXT_PUBLIC_IMAGE_HOSTS || "")
  .split(",")
  .filter(Boolean)
  .map((h) => ({ protocol: "https" as const, hostname: h }));

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  compress: true,
  reactCompiler: true,
  // CDN asset prefix — set CDN_URL env var to serve static assets from Cloudflare CDN
  ...(cdnUrl ? { assetPrefix: cdnUrl } : {}),
  transpilePackages: ["@pickket/ui", "@pickket/lib", "@pickket/store"],
  images: {
    loader: "custom",
    loaderFile: "./src/lib/image-loader.ts",
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31536000,
    deviceSizes: [384, 640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    remotePatterns: [
      { protocol: "https", hostname: "**.pickket.kr" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "**.cloudflareusercontent.com" },
      { protocol: "https", hostname: "**.amazonaws.com" },
      { protocol: "https", hostname: "**.cloudfront.net" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "fastly.picsum.photos" },
      ...extraImageHosts,
    ],
  },
  experimental: {
    optimizeCss: true,
    viewTransition: true,
  },
  headers: async () => [
    {
      // All routes except /widget — strict security
      source: "/((?!widget).*)",
      headers: [
        { key: "X-DNS-Prefetch-Control", value: "on" },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
        // same-origin 이면 나이스 결제창이 띄운 카드사 인증 창(신한·토스뱅크 등)과의 연결이 끊겨
        // 「결제완료」를 눌러도 결과가 돌아오지 않고 결제창이 계속 돈다(2026-11-24 실결제 시험).
        // 결제 팝업을 쓰는 PG 는 same-origin-allow-popups 를 쓴다 — 우리 창을 남이 여는 경우의 격리는 그대로다.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
      ],
    },
    {
      // Widget routes — allow iframe embedding
      source: "/widget/:path*",
      headers: [
        { key: "X-DNS-Prefetch-Control", value: "on" },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=(self)",
        },
        {
          key: "Content-Security-Policy",
          value: "frame-ancestors https://*.pickket.kr https://pickket.kr",
        },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
      ],
    },
    {
      source: "/(.*)\\.(js|css|woff2)",
      headers: [
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
      ],
    },
    {
      // 🔴 서비스 워커는 위 *.js 1년 캐시 규칙을 덮어써야 한다 — 아니면 배포해도 옛 워커가 남는다.
      //    (같은 키는 뒤 규칙이 이긴다.)
      source: "/(sw|sw-push)\\.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Service-Worker-Allowed", value: "/" },
      ],
    },
    {
      source: "/(manifest\\.json|offline\\.html)",
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    },
    {
      source: "/(.*)\\.(jpg|jpeg|png|gif|webp|avif|svg|ico)",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=86400, stale-while-revalidate=604800",
        },
      ],
    },
    {
      // Subdomain landing pages — moderate CDN caching
      source: "/s/:subdomain",
      headers: [
        {
          key: "Cache-Control",
          value: "public, s-maxage=60, stale-while-revalidate=300",
        },
        { key: "CDN-Cache-Control", value: "public, max-age=60" },
      ],
    },
    {
      // Subdomain dynamic sub-routes (community, tickets, etc.)
      source: "/s/:subdomain/:path*",
      headers: [
        {
          key: "Cache-Control",
          value: "public, s-maxage=10, stale-while-revalidate=60",
        },
        { key: "CDN-Cache-Control", value: "public, max-age=10" },
      ],
    },
  ],
};
const sentryConfigOptions = {
  silent: true,
  org: "pickket",
  project: "pickket-frontend",
};

const intlConfig = withBundleAnalyzer(withNextIntl(nextConfig));

const loadNextConfig = async (): Promise<NextConfig> => {
  try {
    const { withSentryConfig } = await import("@sentry/nextjs");
    return withSentryConfig(intlConfig, sentryConfigOptions);
  } catch {
    // Sentry package is optional in offline/local environments.
    return intlConfig;
  }
};

export default loadNextConfig;
