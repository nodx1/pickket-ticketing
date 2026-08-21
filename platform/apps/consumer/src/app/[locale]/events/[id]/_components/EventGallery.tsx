"use client";

import { useState } from "react";
import { pickImage } from "@pickket/lib";

interface GalleryImage {
  url: string;
  variants?: Record<string, string> | null;
}

interface EventGalleryProps {
  images: Array<GalleryImage>;
}

export function EventGallery({ images }: EventGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (!images || images.length === 0) return null;

  const safeIndex = Math.min(activeIndex, images.length - 1);
  const active = images[safeIndex];

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-foreground">갤러리</h3>

      {/* 메인 대형 이미지 */}
      <div className="relative aspect-video rounded-2xl overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- 동적 src(외부 URL), next/image remotePatterns 설정 없이 fill 불가 */}
        <img
          src={pickImage(active.variants, "wide", active.url)}
          alt={`갤러리 이미지 ${safeIndex + 1}`}
          loading="lazy"
          className="w-full h-full object-cover"
        />
      </div>

      {/* 썸네일 목록 — 이미지가 2개 이상일 때만 */}
      {images.length > 1 && (
        <div className="grid grid-cols-4 gap-2">
          {images.map((item, index) => (
            <button
              key={`${item.url}-${index}`}
              type="button"
              onClick={() => setActiveIndex(index)}
              aria-label={`갤러리 이미지 ${index + 1} 보기`}
              aria-current={index === safeIndex}
              className={`relative aspect-[4/3] rounded-2xl overflow-hidden bg-muted transition-all ${
                index === safeIndex
                  ? "ring-2 ring-primary"
                  : "opacity-70 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- 동적 src(외부 URL), next/image remotePatterns 설정 없이 fill 불가 */}
              <img
                src={pickImage(item.variants, "thumb", item.url)}
                alt={`갤러리 썸네일 ${index + 1}`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
