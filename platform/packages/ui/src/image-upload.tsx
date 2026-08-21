"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ImagePlus, Loader2, Trash2, AlertCircle } from "lucide-react";
import { cn } from "@pickket/lib";

export interface ImageUploadProps {
  /** Upload type sent to backend: "event" | "avatar" | "fanclub" | "venue" | "review" */
  uploadType: string;
  /** Current image URL (controlled) */
  value?: string;
  /** Called when upload succeeds: (publicUrl, assetId) */
  onChange: (url: string, assetId: string) => void;
  /** Called when image is removed */
  onRemove?: () => void;
  /** Max file size in MB (default: 5) */
  maxSizeMB?: number;
  /** CSS aspect-ratio value: "4/3" | "1/1" | "16/9" (default: "4/3") */
  aspectRatio?: string;
  /** Additional class names */
  className?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
}

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
];
const DEFAULT_MAX_SIZE_MB = 5;

function getRequiredAssetId(presigned: { asset_id?: string }): string {
  if (!presigned.asset_id) {
    throw new Error("업로드 자산 ID를 받지 못했습니다.");
  }
  return presigned.asset_id;
}

export function ImageUpload({
  uploadType,
  value,
  onChange,
  onRemove,
  maxSizeMB = DEFAULT_MAX_SIZE_MB,
  aspectRatio = "4/3",
  className,
  placeholder = "이미지를 드래그하거나 클릭하여 업로드",
  disabled = false,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const validateFile = useCallback(
    (file: File): string | null => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        return "지원하지 않는 이미지 형식입니다. (JPEG, PNG, WebP, AVIF, GIF)";
      }
      if (file.size > maxSizeMB * 1024 * 1024) {
        return `파일 크기가 ${maxSizeMB}MB를 초과합니다.`;
      }
      return null;
    },
    [maxSizeMB],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);
      setIsUploading(true);
      setProgress(0);
      let objectUrl: string | null = null;

      try {
        // 1. Client-side compression
        const imageCompression = (await import("browser-image-compression"))
          .default;
        const compressed = await imageCompression(file, {
          maxWidthOrHeight: 2400,
          maxSizeMB,
          useWebWorker: true,
          fileType: "image/webp",
        });

        // 2. Set local preview
        objectUrl = URL.createObjectURL(compressed);
        setPreviewUrl(objectUrl);
        setProgress(10);

        // 3. Get presigned URL from backend
        const { getPresignedUrl, uploadComplete } =
          await import("@pickket/lib/api");
        const presigned = await getPresignedUrl(
          uploadType,
          compressed.name || file.name,
          compressed.type || "image/webp",
        );
        setProgress(20);

        // 4. Upload to S3 with progress tracking
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(presigned.method || "PUT", presigned.upload_url);

          // Set headers from presigned response
          if (presigned.headers) {
            for (const [key, val] of Object.entries(presigned.headers)) {
              xhr.setRequestHeader(key, val);
            }
          }

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setProgress(20 + Math.round((e.loaded / e.total) * 60));
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`업로드 실패 (${xhr.status})`));
            }
          };

          xhr.onerror = () =>
            reject(new Error("네트워크 오류가 발생했습니다."));
          xhr.send(compressed);
        });
        setProgress(85);

        // 5. Notify backend upload is complete
        const assetId = getRequiredAssetId(presigned);
        const result = await uploadComplete({
          asset_id: assetId,
          key: presigned.key,
        });
        setProgress(100);

        // 6. Call onChange with final URL
        onChange(
          result.public_url || presigned.public_url,
          result.asset_id || "",
        );

        // Cleanup preview
        setPreviewUrl(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
        setPreviewUrl(null);
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        setIsUploading(false);
        setProgress(0);
      }
    },
    [uploadType, maxSizeMB, onChange],
  );

  const handleFileSelect = useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }
      uploadFile(file);
    },
    [validateFile, uploadFile],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
      // Reset input so same file can be re-selected
      if (inputRef.current) inputRef.current.value = "";
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleRemove = useCallback(() => {
    setError(null);
    setPreviewUrl(null);
    onRemove?.();
  }, [onRemove]);

  const displayUrl = previewUrl || value;

  return (
    <div className={cn("relative", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        className="sr-only"
        onChange={handleInputChange}
        disabled={disabled || isUploading}
      />

      {displayUrl ? (
        /* Image preview */
        <div
          className="relative rounded-xl overflow-hidden border border-border group"
          style={{ aspectRatio }}
        >
          <img
            src={displayUrl}
            alt="업로드된 이미지"
            className="w-full h-full object-cover"
          />
          {/* Upload progress overlay */}
          {isUploading && (
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
              <Loader2 className="h-8 w-8 text-white animate-spin" />
              <div className="w-3/4 h-2 bg-white/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-white text-sm">{progress}%</span>
            </div>
          )}
          {/* Hover actions */}
          {!isUploading && !disabled && (
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                title="이미지 변경"
              >
                <ImagePlus className="h-5 w-5 text-gray-700" />
              </button>
              {onRemove && (
                <button
                  type="button"
                  onClick={handleRemove}
                  className="p-2 bg-red-500/90 rounded-full hover:bg-red-500 transition-colors"
                  title="이미지 삭제"
                >
                  <Trash2 className="h-5 w-5 text-white" />
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Drop zone */
        <button
          type="button"
          disabled={disabled || isUploading}
          onClick={() => inputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "w-full rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center gap-2 p-6 cursor-pointer",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/50 hover:bg-muted/30",
            disabled && "opacity-50 cursor-not-allowed",
          )}
          style={{ aspectRatio }}
        >
          {isUploading ? (
            <>
              <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
              <span className="text-sm text-muted-foreground">
                {progress}% 업로드 중...
              </span>
            </>
          ) : (
            <>
              <ImagePlus className="h-8 w-8 text-muted-foreground" />
              <span className="text-sm text-muted-foreground text-center">
                {placeholder}
              </span>
              <span className="text-xs text-muted-foreground">
                최대 {maxSizeMB}MB · JPEG, PNG, WebP, AVIF, GIF
              </span>
            </>
          )}
        </button>
      )}

      {/* Error message */}
      {error && (
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1.5 text-xs text-red-500">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setError(null);
              inputRef.current?.click();
            }}
            className="text-xs text-primary hover:underline flex-shrink-0 ml-2"
          >
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}
