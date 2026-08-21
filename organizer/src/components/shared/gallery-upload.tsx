"use client";

import { ImagePlus, Loader2, X, ArrowLeft, ArrowRight } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { GALLERY_CAPTION_MAX, GALLERY_MAX_IMAGES } from "@/lib/public/gallery-item";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

export interface GalleryItem {
  /** 마스터 이미지 URL (WebP) */
  url: string;
  /** 화면비별 렌디션 맵 {wide,portrait,thumb,og} */
  variants?: Record<string, string> | null;
  /**
   * 이미지 설명 — 공개 랜딩에서 썸네일 하단·확대뷰에 노출되고 `alt` 로도 쓰인다.
   * ⚠️ 저장되려면 **양쪽 zod 스키마**(`api/events/route.ts`·`api/events/[eventId]/route.ts`)에
   *    필드가 있어야 한다. zod 는 기본 strip 이라 없으면 조용히 사라진다.
   */
  caption?: string;
}

interface GalleryUploadProps {
  value: GalleryItem[];
  onChange: (items: GalleryItem[]) => void;
  label?: string;
  /** 최대 장수 — 미지정 시 GALLERY_MAX_IMAGES(정본: lib/public/gallery-item.ts) */
  max?: number;
  uploadType?: "event" | "product" | "general";
}

/**
 * 갤러리 멀티 이미지 업로드 — 서버프록시(렌디션 생성)로 업로드, 최대 max 장.
 * 순서변경(◀▶) + 개별 삭제. 각 이미지는 화면비별 렌디션을 함께 보관.
 */
export function GalleryUpload({
  value,
  onChange,
  label = "갤러리 이미지",
  max = GALLERY_MAX_IMAGES,
  uploadType = "event",
}: GalleryUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const canAdd = value.length < max;

  async function uploadFiles(files: File[]) {
    const slots = max - value.length;
    if (slots <= 0) {
      showError(`갤러리는 최대 ${max}장까지 등록할 수 있습니다`);
      return;
    }
    const picked = files.slice(0, slots);
    setUploading(true);
    try {
      const uploaded: GalleryItem[] = [];
      for (const file of picked) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("uploadType", uploadType);
        const res = await fetchWithRefresh("/api/upload", { method: "POST", credentials: "include", body: fd });
        const payload = (await res.json()) as {
          data?: { url: string; variants: Record<string, string> | null };
          error?: string;
        };
        if (!res.ok || !payload.data) throw new Error(payload.error ?? "업로드에 실패했습니다");
        uploaded.push({ url: payload.data.url, variants: payload.data.variants ?? null });
      }
      onChange([...value, ...uploaded]);
      showSuccess(`이미지 ${uploaded.length}장이 추가되었습니다`);
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function setCaption(i: number, caption: string) {
    onChange(value.map((item, idx) => (idx === i ? { ...item, caption } : item)));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground">
          {value.length} / {max}장
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {value.map((item, i) => (
          <div key={`${item.url}-${i}`} className="space-y-1.5">
            <div className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-border">
              <Image src={item.variants?.thumb || item.url} alt={item.caption?.trim() || `갤러리 ${i + 1}`} fill className="object-cover" unoptimized />
              <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded-full bg-white/90 p-1.5 text-foreground disabled:opacity-30" aria-label="앞으로">
                  <ArrowLeft className="size-4" />
                </button>
                <button type="button" onClick={() => removeAt(i)} className="rounded-full bg-white/90 p-1.5 text-error" aria-label="삭제">
                  <X className="size-4" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} className="rounded-full bg-white/90 p-1.5 text-foreground disabled:opacity-30" aria-label="뒤로">
                  <ArrowRight className="size-4" />
                </button>
              </div>
              {i === 0 && (
                <span className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-white">대표</span>
              )}
            </div>
            <input
              type="text"
              value={item.caption ?? ""}
              onChange={(e) => setCaption(i, e.target.value.slice(0, GALLERY_CAPTION_MAX))}
              maxLength={GALLERY_CAPTION_MAX}
              placeholder="설명 (선택)"
              aria-label={`갤러리 ${i + 1} 설명`}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
        ))}

        {canAdd && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-muted text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            {uploading ? <Loader2 className="size-6 animate-spin" /> : <ImagePlus className="size-6" />}
            <span className="text-xs">이미지 추가</span>
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        jpg·png·webp·gif / 최대 10MB · 업로드 시 자동 최적화됩니다. 첫 번째가 대표로 노출됩니다.
        <br />
        설명을 넣으면 사진 아래에 표시되고, 클릭해 크게 볼 때 함께 보입니다. 약도·안내문이라면 넣어주세요.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void uploadFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
