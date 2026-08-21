import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// ─────────── 전역 보안 헤더 ───────────
// CSP 는 per-request nonce 를 위해 src/proxy.ts 가 SoT 로 관리(정적 CSP 제거).
// 여기서는 nonce 가 필요 없는 정적 보안 헤더만 일괄 설정한다.
const GLOBAL_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(self), payment=(self)",
  },
];

// HSTS는 HTTPS 프로덕션에서만 활성화 (로컬 dev는 HTTP)
if (process.env.NODE_ENV === "production") {
  GLOBAL_SECURITY_HEADERS.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });
}

const nextConfig: NextConfig = {
  // Docker multistage 빌드용 standalone 산출물
  output: "standalone",
  allowedDevOrigins: ["192.168.0.33", "localhost"],
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "**.pickket.kr" },
      { protocol: "https", hostname: "pickket-assets.s3.ap-northeast-2.amazonaws.com" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
    ],
  },
  poweredByHeader: false,
  headers: async () => [
    {
      // 전역 보안 헤더 (/embed 제외 — iframe 임베드용)
      source: "/((?!embed).*)",
      headers: GLOBAL_SECURITY_HEADERS,
    },
    {
      // /embed 경로: frame-ancestors 를 허용 도메인(환경변수)으로 제한 — 임의 도메인 임베드 방지 (#28 수정).
      // EMBED_ALLOWED_ORIGINS 미설정 시 'none' 으로 폴백(모든 임베드 차단).
      source: "/embed/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: `frame-ancestors ${process.env.EMBED_ALLOWED_ORIGINS ?? "'none'"}`,
        },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
    {
      source: "/api/:path*",
      headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
    },
    {
      source: "/uploads/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Content-Security-Policy", value: "default-src 'none'" },
      ],
    },
  ],
};

export default withSentryConfig(nextConfig, {
  silent: true,
  disableLogger: true,
});
