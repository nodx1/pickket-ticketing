"use client";

import { ImagePlus, Loader2, X } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface ImageUploadProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** S3 키 prefix 용도 (기본: "general") */
  uploadType?: "event" | "organizer" | "product" | "ticket" | "bridge" | "general";
  /** 서버가 생성한 화면비별 렌디션 맵(wide/portrait/thumb/og). 폼이 이벤트에 저장. */
  onVariantsChange?: (variants: Record<string, string> | null) => void;
  /**
   * 이 업로드 자리 전용 권장 규격 안내. uploadType 기본 안내를 덮어쓴다.
   * 🔴 같은 "event" 라도 가로 히어로(21:9)와 세로 히어로(3:4)는 규격이 다르다 —
   *    안내가 하나뿐이면 주최자가 맞출 수가 없다.
   */
  hint?: { size: string; tip: string };
}

const IMAGE_GUIDES: Partial<Record<ImageUploadProps["uploadType"] & string, { size: string; tip: string }>> = {
  event: {
    size: "가로 2520 × 1080 (21:9) 권장",
    tip: "랜딩 히어로에 이 비율 그대로 들어갑니다. 다른 비율로 올리면 좌우나 위아래가 잘립니다.",
  },
  organizer: {
    size: "정사각형 로고 권장 (400px 이상)",
    tip: "자동으로 최적 위치를 잡아 맞춥니다.",
  },
  product: {
    size: "정사각형 이미지 권장 (800px 이상)",
    tip: "업로드하면 자동으로 최적화됩니다.",
  },
};

export function ImageUpload({ value, onChange, label, uploadType = "general", onVariantsChange, hint }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const guide = hint ?? IMAGE_GUIDES[uploadType];

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      // 서버프록시: 파일을 서버로 보내면 서버가 검증·처리(WebP·렌디션 4종)·저장 후
      // { url(마스터), variants } 반환. 클라의 presign+PUT 왕복 제거.
      const fd = new FormData();
      fd.append("file", file);
      fd.append("uploadType", uploadType);
      const res = await fetchWithRefresh("/api/upload", { method: "POST", credentials: "include", body: fd });
      const payload = (await res.json()) as {
        data?: { url: string; variants: Record<string, string> | null };
        error?: string;
      };
      if (!res.ok || !payload.data) {
        throw new Error(payload.error ?? "업로드에 실패했습니다");
      }
      onChange(payload.data.url);
      onVariantsChange?.(payload.data.variants ?? null);
      showSuccess("이미지가 업로드되었습니다");
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <Label>{label}</Label>
      <div
        className="rounded-lg border border-dashed border-border bg-muted p-5"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file) {
            void uploadFile(file);
          }
        }}
      >
        {value ? (
          <div className="space-y-3">
            <div className="relative aspect-[16/9] overflow-hidden rounded-[24px] border border-border">
              <Image src={value} alt={label} fill className="object-cover" unoptimized />
            </div>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
                이미지 변경
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onChange("");
                  onVariantsChange?.(null); // 마스터 삭제 시 렌디션 맵도 비워 stale 렌디션 전파 방지
                }}
              >
                <X className="size-4" />
                삭제
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            {uploading ? <Loader2 className="size-8 animate-spin text-primary" /> : <ImagePlus className="size-8 text-primary" />}
            <div>
              <p className="font-medium text-foreground">이미지를 드래그하거나 선택해 업로드하세요</p>
              <p className="mt-1 text-sm text-muted-foreground">jpg, png, webp, gif / 최대 10MB</p>
              {guide && (
                <div className="mt-2 space-y-0.5">
                  <p className="text-sm font-medium text-primary">{guide.size}</p>
                  <p className="text-xs text-muted-foreground">{guide.tip}</p>
                </div>
              )}
            </div>
            <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
              파일 선택
            </Button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void uploadFile(file);
            }
          }}
        />
      </div>
    </div>
  );
}
