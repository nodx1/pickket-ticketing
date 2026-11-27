import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const extraImageHosts = (process.env.NEXT_PUBLIC_IMAGE_HOSTS || "")
  .split(",")
  .filter(Boolean)
  .map((h) => ({ protocol: "https" as const, hostname: h }));

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8021";

// 「/uploads/…」 이미지가 실제로 있는 곳.
// 로컬 개발에서는 피켓고(UPLOAD_PROVIDER=local)가 이벤트 대표 이미지를 자기 public/uploads 에 두고
// 「/uploads/…」 상대 주소로 저장한다. 백엔드는 /uploads 를 제공하지 않아서 관리자 화면 이미지가 깨졌다.
// 그래서 개발 서버에서만 피켓고로 넘긴다. 배포 동작(API 서버로 넘김)은 그대로다.
const UPLOADS_ORIGIN =
  process.env.NODE_ENV !== "production"
    ? (process.env.NEXT_PUBLIC_GO_URL || "http://localhost:3033").replace(/\/$/, "")
    : API_URL;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  transpilePackages: ["@pickket/ui", "@pickket/lib", "@pickket/store"],
  rewrites: async () => [
    { source: "/uploads/:path*", destination: `${UPLOADS_ORIGIN}/uploads/:path*` },
  ],
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31536000,
    remotePatterns: [
      { protocol: "https", hostname: "**.pickket.kr" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "**.cloudflareusercontent.com" },
      ...extraImageHosts,
    ],
  },
  headers: async () => [
    {
      source: "/:path*",
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
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
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
      source: "/(.*)\\.(jpg|jpeg|png|gif|webp|avif|svg|ico)",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=86400, stale-while-revalidate=604800",
        },
      ],
    },
  ],
};
const sentryConfigOptions = {
  silent: true,
  org: "pickket",
  project: "pickket-frontend",
};

const intlConfig = withNextIntl(nextConfig);

const loadNextConfig = async (): Promise<NextConfig> => {
  try {
    const { withSentryConfig } = await import("@sentry/nextjs");
    return withSentryConfig(intlConfig, sentryConfigOptions);
  } catch {
    return intlConfig;
  }
};

export default loadNextConfig;
