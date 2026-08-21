import { Dimensions } from "react-native";

const SCREEN_WIDTH = Dimensions.get("window").width;

/**
 * CDN 이미지 리사이징 URL 생성
 */
export function optimizedImageUrl(
  url: string,
  width: number,
  quality = 80,
): string {
  if (!url) return "";
  if (url.includes("cdn-cgi")) return url; // 이미 최적화됨
  // Cloudflare/imgproxy 패턴 — 백엔드 CDN 구조에 따라 조정
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}w=${width}&q=${quality}&f=webp`;
}

export const IMAGE_PRESETS = {
  discoverCard: (url: string) => optimizedImageUrl(url, SCREEN_WIDTH, 85),
  eventCardLarge: (url: string) =>
    optimizedImageUrl(url, SCREEN_WIDTH - 48, 80),
  eventCardCompact: (url: string) => optimizedImageUrl(url, 400, 75),
  heroDetail: (url: string) => optimizedImageUrl(url, SCREEN_WIDTH, 90),
  thumbnail: (url: string) => optimizedImageUrl(url, 200, 70),
} as const;
