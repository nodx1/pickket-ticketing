/**
 * S3 스토리지 서비스 — presigned URL 기반 이미지 업로드
 *
 * v2와 동일 패턴: 서버가 presigned URL 발급 → 클라이언트가 S3에 직접 PUT 업로드.
 * 서버는 파일을 만지지 않음 → ECS 서버 부하 0, 컨테이너 재시작해도 파일 유지.
 *
 * 환경변수:
 *   S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY
 *   S3_PUBLIC_URL (CDN URL, 없으면 S3 직접 URL)
 *   S3_ENDPOINT_URL (R2/MinIO용, AWS S3면 비워둠)
 *   UPLOAD_PROVIDER (s3 | local)
 */
import crypto from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";

// ── 타입 ──

export interface PresignedUrlResult {
  /** S3 presigned PUT URL (5분 만료) */
  uploadUrl: string;
  /** S3 오브젝트 키 */
  key: string;
  /** 업로드 완료 후 접근 가능한 퍼블릭 URL */
  publicUrl: string;
  /** HTTP 메서드 */
  method: "PUT";
  /** 클라이언트가 PUT 요청에 포함해야 할 헤더 */
  headers: Record<string, string>;
}

// ── 허용 타입 / 검증 ──

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type UploadType =
  | "event"
  | "organizer"
  | "product"
  | "ticket"
  | "bridge"
  | "general"
  | "seat-map-bg" // 트랙 2.1 — 좌석맵 배경 도면
  | "seat-view" // 트랙 2.13 — tier 시야 미리보기 이미지
  | "business-cert"; // 사업자 인증 — 등록증·통장 사본(심사기간 보관)

/**
 * S3 키 생성 — v2 호환 패턴.
 * `go/{uploadType}/{YYYYMMDD}/{uuid12}.{ext}`
 */
export function generateUploadKey(uploadType: UploadType, contentType: string): string {
  const ext = EXTENSION_MAP[contentType] ?? ".jpg";
  return `${generateKeyBase(uploadType)}${ext}`;
}

/** 확장자 없는 키 베이스 — 렌디션(`{base}-wide.webp` 등)에 공용. `go/{type}/{YYYYMMDD}/{uuid12}` */
export function generateKeyBase(uploadType: UploadType): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `go/${uploadType}/${date}/${hash}`;
}

// ── Provider 인터페이스 ──

interface StorageProvider {
  generatePresignedUrl(key: string, contentType: string): Promise<PresignedUrlResult>;
  getPublicUrl(key: string): string;
  headObject(key: string): Promise<{ contentLength: number; contentType: string } | null>;
  deleteObject(key: string): Promise<boolean>;
  /** 서버측 직접 업로드(버퍼) — 서버프록시 처리(렌디션) 저장용. publicUrl 반환. */
  uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string>;
}

// ── S3 Provider ──

class S3StorageProvider implements StorageProvider {
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  private bucket: string;
  private region: string;
  private publicUrl: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? "";
    this.region = process.env.S3_REGION ?? "ap-northeast-2";
    this.publicUrl = (process.env.S3_PUBLIC_URL ?? "").replace(/\/$/, "");
  }

  private async getClient() {
    if (!this.client) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const endpointUrl = process.env.S3_ENDPOINT_URL;
      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY ?? "",
          secretAccessKey: process.env.S3_SECRET_KEY ?? "",
        },
        ...(endpointUrl ? { endpoint: endpointUrl, forcePathStyle: true } : {}),
      });
    }
    return this.client;
  }

  async generatePresignedUrl(key: string, contentType: string): Promise<PresignedUrlResult> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

    const client = await this.getClient();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

    return {
      uploadUrl,
      key,
      publicUrl: this.getPublicUrl(key),
      method: "PUT",
      headers: { "Content-Type": contentType },
    };
  }

  getPublicUrl(key: string): string {
    if (this.publicUrl) {
      return `${this.publicUrl}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async headObject(key: string) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await this.getClient();
      const result = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? "",
      };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<boolean> {
    try {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await this.getClient();
      await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // 렌디션은 콘텐츠 해시 키라 불변 — 장기 캐시.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return this.getPublicUrl(key);
  }
}

// ── Local Provider (개발용) ──

class LocalStorageProvider implements StorageProvider {
  async generatePresignedUrl(key: string, contentType: string): Promise<PresignedUrlResult> {
    // 로컬에서는 presigned URL 대신 서버 업로드 엔드포인트 반환
    return {
      uploadUrl: "/api/upload",
      key,
      publicUrl: `/uploads/${key.split("/").pop()}`,
      method: "PUT",
      headers: { "Content-Type": contentType },
    };
  }

  getPublicUrl(key: string): string {
    return `/uploads/${key.split("/").pop()}`;
  }

  async headObject(): Promise<{ contentLength: number; contentType: string } | null> {
    return { contentLength: 0, contentType: "image/jpeg" };
  }

  async deleteObject(): Promise<boolean> {
    return true;
  }

  async uploadBuffer(key: string, buffer: Buffer): Promise<string> {
    // 로컬은 키의 basename 으로 평탄화 저장(기존 saveLocalFile 규약과 일치).
    const filename = key.split("/").pop() ?? key;
    return saveLocalFile(buffer, filename);
  }
}

// ── Factory ──

let _provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!_provider) {
    const providerType = (process.env.UPLOAD_PROVIDER ?? "s3").toLowerCase();
    if (providerType === "local") {
      _provider = new LocalStorageProvider();
      logger.info("스토리지: 로컬 파일시스템 (개발 모드)");
    } else {
      _provider = new S3StorageProvider();
      logger.info("스토리지: S3", { bucket: process.env.S3_BUCKET, region: process.env.S3_REGION });
    }
  }
  return _provider;
}

/**
 * 로컬 파일 저장 (UPLOAD_PROVIDER=local 전용, 서버사이드 업로드)
 */
export async function saveLocalFile(buffer: Buffer, filename: string): Promise<string> {
  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(path.join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}
