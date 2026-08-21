"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useState } from "react";

import type { GalleryView } from "@/lib/public/gallery-item";

/**
 * 공개 랜딩 갤러리 — 썸네일 그리드 + 전체화면 확대.
 *
 * 🔴 왜 만들었나
 * 종전 갤러리는 클릭이 안 되는 정적 그리드였고, 1440 화면에서 한 칸이 237×177px 였다.
 * 주최자가 넣은 안내(에티켓·약도)가 **물리적으로 읽을 수 없는 크기**로만 노출됐다.
 *
 * 잘림도 같은 뿌리다 — `object-cover` 는 사진에는 맞지만 **정보성 이미지에는 틀리다**.
 * 여백을 남기더라도 다 보이는 쪽(`object-contain`)이 맞다.
 *
 * 접근성: `DialogPrimitive` 를 직접 쓰는 이유는 포커스 트랩·ESC·스크롤 락을 얻기 위해서다.
 * 제목은 화면에 안 보이지만 낭독기에는 필요해 `sr-only` 로 남긴다.
 */
export function GalleryLightbox({ items }: { items: GalleryView[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const move = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null) return current;
        // 끝에서 반대편으로 넘어간다 — 4장뿐이라 막다른 끝이 답답하다.
        return (current + delta + items.length) % items.length;
      });
    },
    [items.length],
  );

  if (items.length === 0) return null;
  const active = openIndex === null ? null : items[openIndex];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((item, i) => (
          <button
            key={`${item.url}-${i}`}
            type="button"
            onClick={() => setOpenIndex(i)}
            aria-label={`${item.alt} — 크게 보기`}
            className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-muted transition hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- 외부/로컬 혼용 URL, next/image remotePatterns 불필요 */}
            <img
              src={item.thumbUrl}
              alt={item.alt}
              loading="lazy"
              width={640}
              height={480}
              className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
            />
            {item.caption ? (
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-left text-[11px] text-white">
                {item.caption}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <DialogPrimitive.Root open={openIndex !== null} onOpenChange={(next) => !next && setOpenIndex(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-fade-in" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
              if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
            }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-4 outline-none sm:p-8"
          >
            <DialogPrimitive.Title className="sr-only">
              {active?.alt ?? "갤러리 이미지"}
            </DialogPrimitive.Title>

            {active ? (
              /* eslint-disable-next-line @next/next/no-img-element -- 외부/로컬 혼용 URL, next/image remotePatterns 불필요 */
              <img
                src={active.url}
                alt={active.alt}
                className="max-h-[78vh] w-auto max-w-full rounded-lg object-contain"
              />
            ) : null}

            {active?.caption ? (
              <p className="max-w-2xl text-center text-sm leading-relaxed text-white">{active.caption}</p>
            ) : null}

            {items.length > 1 ? (
              <>
                <p className="text-xs text-white/70">
                  {(openIndex ?? 0) + 1} / {items.length}
                </p>
                <button
                  type="button"
                  onClick={() => move(-1)}
                  aria-label="이전 이미지"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-3 text-white transition hover:bg-white/30 sm:left-6"
                >
                  <ChevronLeft className="size-6" />
                </button>
                <button
                  type="button"
                  onClick={() => move(1)}
                  aria-label="다음 이미지"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-3 text-white transition hover:bg-white/30 sm:right-6"
                >
                  <ChevronRight className="size-6" />
                </button>
              </>
            ) : null}

            <DialogPrimitive.Close
              aria-label="닫기"
              className="absolute right-3 top-3 rounded-full bg-white/15 p-2.5 text-white transition hover:bg-white/30 sm:right-6 sm:top-6"
            >
              <X className="size-5" />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
