/**
 * 이미지 처리 — sharp 기반. 업로드 시 서버에서 호출(서버프록시).
 *
 * - EXIF 방향 자동보정(rotate) 후 메타 제거(개인정보/용량)
 * - 마스터: 최장변 상한 리사이즈 + WebP
 * - 렌디션 4종: 화면비별 smart-crop(attention) + WebP
 *   wide 21:9(랜딩 히어로) / portrait 3:4(모바일 히어로·카드) / thumb 4:3(그리드) / og 1200×630(공유)
 *
 * sharp 실패 시 null 반환 → 호출측이 원본 저장으로 폴백(무손상).
 */

export type RenditionKey = "wide" | "portrait" | "thumb" | "og";

/** 화면 인벤토리(IMAGE_PIPELINE_IMPROVEMENT_PLAN §2) 기준 렌디션 스펙 */
export const RENDITIONS: Record<RenditionKey, { width: number; height: number }> = {
  // 🔴 21:9 — 공개 랜딩 히어로. **컨테이너 비율과 일치해야** 잘림이 0 이 된다.
  //   종전 16:9(1600×900)는 주석에 "히어로용" 이라 적혀 있었지만 히어로 컨테이너는 16:9 가
  //   아니었다(높이 560px 고정 → 1920 화면에서 3.43:1). 그래서 **세로 48% 가 잘렸다.**
  //   히어로를 21:9 로 고정하면서 렌디션도 같은 비율로 맞춘다. 실제 소비자는 히어로 한 곳뿐이다
  //   (grep 실측 — 주석의 "배너/티켓/#events" 는 사실이 아니었다).
  //   2520 폭은 QHD(2560) 화면까지 선명하게 덮는다. MASTER_MAX_EDGE(2560) 안에 들어간다.
  wide: { width: 2520, height: 1080 }, // 21:9 — 공개 랜딩 히어로
  portrait: { width: 900, height: 1200 }, // 3:4 — 소비자 상세/트렌딩/카드
  thumb: { width: 800, height: 600 }, // 4:3 — 마켓 그리드
  og: { width: 1200, height: 630 }, // 1.91:1 — 카톡/SNS 공유
};

const MASTER_MAX_EDGE = 2560; // 마스터 최장변 상한
const WEBP_QUALITY = 82;
const JPEG_QUALITY = 82;

/**
 * 렌디션별 출력 포맷. og 는 **JPEG** — 카카오톡 등 국내 SNS 링크 미리보기가 WebP
 * og:image 를 렌더 못 하는 경우가 있어 호환성 위해 JPEG 고정. 나머지는 WebP(경량).
 */
export const RENDITION_FORMAT: Record<RenditionKey, { ext: "webp" | "jpg"; contentType: string }> = {
  wide: { ext: "webp", contentType: "image/webp" },
  portrait: { ext: "webp", contentType: "image/webp" },
  thumb: { ext: "webp", contentType: "image/webp" },
  og: { ext: "jpg", contentType: "image/jpeg" },
};

export interface ProcessedImage {
  /** 최적화 마스터(WebP, 상한 리사이즈) */
  master: Buffer;
  /** 화면비별 렌디션(WebP, smart-crop) */
  renditions: Record<RenditionKey, Buffer>;
}

/**
 * 원본 버퍼 → 마스터 + 렌디션 4종. 실패 시 null(호출측 원본 폴백).
 */
export async function processImage(buffer: Buffer): Promise<ProcessedImage | null> {
  try {
    const sharp = (await import("sharp")).default;

    // 마스터: EXIF 방향 보정 → 상한 리사이즈(확대 금지) → WebP(메타 자동 제거)
    const master = await sharp(buffer)
      .rotate()
      .resize(MASTER_MAX_EDGE, MASTER_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    // 렌디션: 화면비별 attention smart-crop(인물·로고 등 시선집중 영역 우선)
    // og 만 JPEG(카톡 호환), 나머지 WebP.
    const keys = Object.keys(RENDITIONS) as RenditionKey[];
    const bufs = await Promise.all(
      keys.map((k) => {
        const pipe = sharp(buffer)
          .rotate()
          .resize(RENDITIONS[k].width, RENDITIONS[k].height, {
            fit: "cover",
            position: sharp.strategy.attention,
          });
        return RENDITION_FORMAT[k].ext === "jpg"
          ? pipe.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
          : pipe.webp({ quality: WEBP_QUALITY }).toBuffer();
      }),
    );
    const renditions = Object.fromEntries(keys.map((k, i) => [k, bufs[i]])) as Record<
      RenditionKey,
      Buffer
    >;
    return { master, renditions };
  } catch {
    return null;
  }
}

// ── 하위 호환(기존 export 유지) ──
export async function resizeImage(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buffer).resize(width, height, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
  } catch {
    return buffer;
  }
}

export async function generateOgImage(buffer: Buffer): Promise<Buffer> {
  return resizeImage(buffer, 1200, 630);
}
