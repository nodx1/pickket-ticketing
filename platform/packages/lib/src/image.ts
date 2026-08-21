/**
 * 이벤트 이미지 렌디션 선택 유틸.
 *
 * v2 API 는 events 에 `image_variants?: Record<string,string> | null` 를 반환한다.
 * 키: `wide` (16:9), `portrait` (3:4), `thumb` (4:3), `og` (1200x630).
 * 마스터 원본은 `image_url`.
 *
 * 각 surface 는 컨테이너 종횡비에 맞는 렌디션을 고르고, 변형/맵이 없으면
 * fallback(보통 image_url, 그다음 샘플/플레이스홀더)으로 폴백한다.
 */
export function pickImage(
  variants: Record<string, string> | null | undefined,
  key: "wide" | "portrait" | "thumb" | "og",
  fallback?: string | null,
): string | undefined {
  return variants?.[key] || fallback || undefined;
}
