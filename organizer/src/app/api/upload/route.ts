/**
 * 이미지 업로드 API
 *
 * 서버프록시 모드 (신규, 기본 — image-upload.tsx):
 *   POST /api/upload  (multipart/form-data: file, uploadType)
 *     → 서버가 바이트검증 + sharp 처리(EXIF strip·WebP·렌디션 4종) → S3 업로드
 *     → { url(마스터), variants:{wide,portrait,thumb,og} }
 *
 * Presigned 모드 (레거시, JSON — 좌석맵 등 원본 직접업로드):
 *   POST /api/upload  (application/json: uploadType, filename, contentType)
 *     → presigned URL 발급 → 클라이언트가 S3에 직접 PUT
 *
 * Local PUT (개발, 하위호환): PUT /api/upload (FormData)
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { withAuth } from "@/lib/auth/withAuth";
import { logger } from "@/lib/logger";
import { processImage, RENDITION_FORMAT, type RenditionKey } from "@/lib/image/processor";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_FILE_SIZE,
  generateKeyBase,
  generateUploadKey,
  getStorageProvider,
  saveLocalFile,
  type UploadType,
} from "@/lib/storage/s3";
import { randomUUID } from "node:crypto";

const UPLOAD_TYPES = new Set<UploadType>([
  "event",
  "organizer",
  "product",
  "ticket",
  "bridge",
  "general",
  "seat-map-bg",
  "seat-view",
  "business-cert",
]);

const EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function detectImageType(buffer: Uint8Array): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
  return null;
}

// ── 서버프록시 업로드 (처리 + 렌디션) ──

async function proxyUploadHandler(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  const uploadType = ((formData.get("uploadType") as string | null) ?? "general") as UploadType;

  if (!UPLOAD_TYPES.has(uploadType)) return errorResponse("올바른 업로드 유형을 선택해주세요", 400);
  if (!(file instanceof File)) return errorResponse("업로드할 파일을 선택해주세요", 400);
  if (file.size > MAX_FILE_SIZE) return errorResponse("이미지는 10MB 이하만 업로드할 수 있습니다", 400);

  const raw = Buffer.from(await file.arrayBuffer());
  const detected = detectImageType(raw);
  // 매직바이트 기준 검증 — 클라 MIME 신뢰 안 함(S3 presigned 경로의 검증갭 해소).
  if (!detected || !ALLOWED_IMAGE_TYPES.has(detected)) {
    const head = Array.from(raw.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    logger.warn("업로드 파일이 허용 이미지 아님", { reportedType: file.type, detected, size: file.size, first16: head });
    return errorResponse("이미지 파일 형식이 올바르지 않습니다", 400);
  }

  const provider = getStorageProvider();
  const base = generateKeyBase(uploadType);

  const processed = await processImage(raw);
  if (!processed) {
    // sharp 처리 실패 → 원본을 마스터로 저장(무손상 폴백), 렌디션 없음.
    const ext = EXTENSION_MAP[detected] ?? ".jpg";
    const url = await provider.uploadBuffer(`${base}${ext}`, raw, detected);
    logger.warn("이미지 처리 실패 — 원본 저장 폴백", { uploadType });
    return successResponse({ url, variants: null }, 201);
  }

  // 마스터 + 렌디션 4종 업로드 (전부 WebP)
  const masterUrl = await provider.uploadBuffer(`${base}.webp`, processed.master, "image/webp");
  const keys = Object.keys(processed.renditions) as RenditionKey[];
  const urls = await Promise.all(
    keys.map((k) =>
      provider.uploadBuffer(
        `${base}-${k}.${RENDITION_FORMAT[k].ext}`,
        processed.renditions[k],
        RENDITION_FORMAT[k].contentType,
      ),
    ),
  );
  const variants = Object.fromEntries(keys.map((k, i) => [k, urls[i]])) as Record<RenditionKey, string>;

  logger.info("이미지 업로드+렌디션", { uploadType, base, variants: keys.length });
  return successResponse({ url: masterUrl, variants }, 201);
}

// ── Presigned URL 발급 (레거시 JSON) ──

async function presignedUploadHandler(request: Request) {
  const body = (await request.json()) as { uploadType?: string; filename?: string; contentType?: string };
  const uploadType = (body.uploadType ?? "general") as UploadType;
  if (!UPLOAD_TYPES.has(uploadType)) return errorResponse("올바른 업로드 유형을 선택해주세요", 400);
  const contentType = body.contentType ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) return errorResponse("jpg, png, webp, gif 파일만 업로드할 수 있습니다", 400);
  const provider = getStorageProvider();
  const key = generateUploadKey(uploadType, contentType);
  const result = await provider.generatePresignedUrl(key, contentType);
  return successResponse(result, 200);
}

export const POST = withRateLimit({ max: 20, windowMs: 3_600_000, keyPrefix: "upload" })(
  withAuth(async (request) => {
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("multipart/form-data")) return await proxyUploadHandler(request);
      return await presignedUploadHandler(request); // JSON 레거시(presigned)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("업로드 실패", { source: "upload", error: message });
      return errorResponse("업로드에 실패했습니다", 500);
    }
  }),
);

// ── 로컬 파일 업로드 (UPLOAD_PROVIDER=local, 하위호환) ──

export const PUT = withAuth(async (request) => {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return errorResponse("업로드할 파일을 선택해주세요", 400);
    if (file.size > MAX_FILE_SIZE) return errorResponse("이미지는 10MB 이하만 업로드할 수 있습니다", 400);

    const fileBuffer = new Uint8Array(await file.arrayBuffer());
    const detectedType = detectImageType(fileBuffer);
    if (!detectedType || !ALLOWED_IMAGE_TYPES.has(detectedType)) {
      return errorResponse("이미지 파일 형식이 올바르지 않습니다", 400);
    }
    const ext = EXTENSION_MAP[detectedType] ?? ".jpg";
    const filename = `${randomUUID()}${ext}`;
    const url = await saveLocalFile(Buffer.from(fileBuffer), filename);
    return successResponse({ url }, 201);
  } catch (err: unknown) {
    if (err instanceof Error) logger.error("로컬 파일 업로드 실패", { source: "upload", error: err.message });
    return errorResponse("파일 업로드에 실패했습니다", 500);
  }
});
