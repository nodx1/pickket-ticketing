export default function pickketLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}) {
  const q = quality || 80;

  // External URLs — pass through with query params for width/quality hints
  if (src.startsWith("http")) {
    try {
      const url = new URL(src);
      url.searchParams.set("w", String(width));
      url.searchParams.set("q", String(q));
      return url.toString();
    } catch {
      return src;
    }
  }

  // Local/relative paths — serve as-is (custom loader disables /_next/image)
  return src;
}
