/**
 * Sample poster images for demo/preview when events have no image_url.
 * Uses picsum.photos with fixed seeds for deterministic, stable results.
 */

const POSTER_SEEDS = [
  "concert",
  "festival",
  "stage",
  "crowd",
  "music",
  "theater",
  "arena",
  "performer",
  "lights",
  "venue",
] as const;

/**
 * Returns a deterministic sample poster URL based on an event ID or index.
 * Useful for fallback when event.image_url is null.
 *
 * @param idOrIndex - Event ID string or numeric index
 * @param width - Image width (default 800)
 * @param height - Image height (default 1067, ~3:4 ratio)
 */
export function getSamplePoster(
  idOrIndex: string | number = 0,
  width = 800,
  height = 1067,
): string {
  const idx =
    typeof idOrIndex === "number"
      ? idOrIndex
      : Math.abs(simpleHash(idOrIndex)) % POSTER_SEEDS.length;
  const seed = POSTER_SEEDS[idx % POSTER_SEEDS.length];
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

/**
 * Returns a deterministic sample thumbnail URL (16:10 ratio for cards).
 */
export function getSampleThumb(
  idOrIndex: string | number = 0,
  width = 640,
  height = 400,
): string {
  const idx =
    typeof idOrIndex === "number"
      ? idOrIndex
      : Math.abs(simpleHash(idOrIndex)) % POSTER_SEEDS.length;
  const seed = POSTER_SEEDS[idx % POSTER_SEEDS.length];
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}
