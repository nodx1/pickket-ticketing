"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ImagePlus,
  Loader2,
  Trash2,
  AlertCircle,
  GripVertical,
} from "lucide-react";
import { cn } from "@pickket/lib";

export interface MultiImageItem {
  url: string;
  assetId: string;
}

export interface MultiImageUploadProps {
  uploadType: string;
  value: MultiImageItem[];
  onChange: (items: MultiImageItem[]) => void;
  maxImages?: number;
  maxSizeMB?: number;
  className?: string;
  disabled?: boolean;
}

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
];
const DEFAULT_MAX_IMAGES = 10;
const DEFAULT_MAX_SIZE_MB = 5;

function getRequiredAssetId(presigned: { asset_id?: string }): string {
  if (!presigned.asset_id) {
    throw new Error("업로드 자산 ID를 받지 못했습니다.");
  }
  return presigned.asset_id;
}

export function MultiImageUpload({
  uploadType,
  value,
  onChange,
  maxImages = DEFAULT_MAX_IMAGES,
  maxSizeMB = DEFAULT_MAX_SIZE_MB,
  className,
  disabled = false,
}: MultiImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const canAddMore = value.length + uploadingCount < maxImages;

  const uploadFile = useCallback(
    async (file: File) => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError("지원하지 않는 이미지 형식입니다.");
        return;
      }
      if (file.size > maxSizeMB * 1024 * 1024) {
        setError(`파일 크기가 ${maxSizeMB}MB를 초과합니다.`);
        return;
      }

      setError(null);
      setUploadingCount((c) => c + 1);

      try {
        const imageCompression = (await import("browser-image-compression"))
          .default;
        const compressed = await imageCompression(file, {
          maxWidthOrHeight: 2400,
          maxSizeMB,
          useWebWorker: true,
          fileType: "image/webp",
        });

        const { getPresignedUrl, uploadComplete } =
          await import("@pickket/lib/api");
        const presigned = await getPresignedUrl(
          uploadType,
          compressed.name || file.name,
          compressed.type || "image/webp",
        );

        // Upload to S3
        const response = await fetch(presigned.upload_url, {
          method: presigned.method || "PUT",
          headers: presigned.headers || {},
          body: compressed,
        });
        if (!response.ok) throw new Error(`업로드 실패 (${response.status})`);

        const result = await uploadComplete({
          asset_id: getRequiredAssetId(presigned),
          key: presigned.key,
        });

        // Append to list
        const nextItems = [
          ...valueRef.current,
          {
            url: result.public_url || presigned.public_url,
            assetId: result.asset_id || "",
          },
        ];
        valueRef.current = nextItems;
        onChange(nextItems);
      } catch (err) {
        setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
      } finally {
        setUploadingCount((c) => c - 1);
      }
    },
    [uploadType, maxSizeMB, onChange],
  );

  const handleFiles = useCallback(
    (files: FileList) => {
      const remaining = maxImages - valueRef.current.length - uploadingCount;
      const filesToUpload = Array.from(files).slice(0, remaining);
      for (const file of filesToUpload) {
        uploadFile(file);
      }
    },
    [maxImages, uploadingCount, uploadFile],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) handleFiles(e.target.files);
      if (inputRef.current) inputRef.current.value = "";
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const handleRemove = useCallback(
    (index: number) => {
      const nextItems = value.filter((_, i) => i !== index);
      valueRef.current = nextItems;
      onChange(nextItems);
    },
    [value, onChange],
  );

  // Drag-to-reorder handlers
  const handleItemDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleItemDragOver = useCallback(
    (e: DragEvent, index: number) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === index) return;
      setDragOverIndex(index);
    },
    [dragIndex],
  );

  const handleItemDrop = useCallback(
    (index: number) => {
      if (dragIndex === null || dragIndex === index) return;
      const newItems = [...value];
      const [moved] = newItems.splice(dragIndex, 1);
      newItems.splice(index, 0, moved);
      valueRef.current = newItems;
      onChange(newItems);
      setDragIndex(null);
      setDragOverIndex(null);
    },
    [dragIndex, value, onChange],
  );

  const handleItemDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div className={cn("space-y-3", className)}>
      {/* Image grid */}
      {value.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
          {value.map((item, index) => (
            <div
              key={`${item.assetId}-${index}`}
              draggable={!disabled}
              onDragStart={() => handleItemDragStart(index)}
              onDragOver={(e) => handleItemDragOver(e, index)}
              onDrop={() => handleItemDrop(index)}
              onDragEnd={handleItemDragEnd}
              className={cn(
                "relative aspect-square rounded-lg overflow-hidden border group cursor-grab",
                dragOverIndex === index && "ring-2 ring-primary",
                dragIndex === index && "opacity-50",
              )}
            >
              <img
                src={item.url}
                alt={`이미지 ${index + 1}`}
                className="w-full h-full object-cover"
              />
              {/* Drag handle */}
              <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <GripVertical className="h-4 w-4 text-white drop-shadow" />
              </div>
              {/* Delete button */}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(index)}
                  className="absolute top-1 right-1 p-1 bg-red-500/80 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-3 w-3 text-white" />
                </button>
              )}
              {/* Index badge */}
              <div className="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                {index + 1}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone */}
      {canAddMore && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_TYPES.join(",")}
            multiple
            className="sr-only"
            onChange={handleInputChange}
            disabled={disabled || !canAddMore}
          />
          <button
            type="button"
            disabled={disabled || !canAddMore}
            onClick={() => inputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              "w-full rounded-xl border-2 border-dashed py-6 flex flex-col items-center gap-2 transition-colors cursor-pointer",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            {uploadingCount > 0 ? (
              <>
                <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
                <span className="text-sm text-muted-foreground">
                  {uploadingCount}개 업로드 중...
                </span>
              </>
            ) : (
              <>
                <ImagePlus className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  이미지 추가 ({value.length}/{maxImages})
                </span>
              </>
            )}
          </button>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-500">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-primary hover:underline flex-shrink-0 ml-2"
          >
            닫기
          </button>
        </div>
      )}
    </div>
  );
}
