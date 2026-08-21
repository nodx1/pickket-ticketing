"use client";

import { useState, useCallback, type ReactNode } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { blurhashToDataURL } from "@pickket/lib";
import { useTranslations } from "next-intl";

const MotionImage = motion.create(Image);

interface ImageGalleryProps {
  images: string[];
  alt: string;
  category?: string;
  title?: string;
  categoryLabel?: string;
  demandBadge?: ReactNode;
  blurhash?: string;
}

const CATEGORY_GRADIENTS: Record<string, string> = {
  concert: "from-red-400 via-pink-500 to-purple-600",
  musical: "from-teal-400 via-emerald-500 to-cyan-600",
  sports: "from-blue-400 via-sky-500 to-indigo-600",
  classical: "from-green-400 via-emerald-500 to-teal-600",
  exhibition: "from-amber-400 via-yellow-500 to-orange-500",
  festival: "from-purple-400 via-fuchsia-500 to-pink-600",
};

export default function ImageGallery({
  images,
  alt,
  category,
  title,
  categoryLabel,
  demandBadge,
  blurhash,
}: ImageGalleryProps) {
  const t = useTranslations("event.imageGallery");
  const [current, setCurrent] = useState(0);
  const [direction, setDirection] = useState(0);
  const [imgError, setImgError] = useState(false);
  const hasMultiple = images.length > 1;

  const go = useCallback(
    (next: number) => {
      setDirection(next > current ? 1 : -1);
      setCurrent(next);
    },
    [current],
  );

  const prev = useCallback(() => {
    go(current === 0 ? images.length - 1 : current - 1);
  }, [current, images.length, go]);

  const next = useCallback(() => {
    go(current === images.length - 1 ? 0 : current + 1);
  }, [current, images.length, go]);

  const handleDragEnd = useCallback(
    (_: unknown, info: { offset: { x: number }; velocity: { x: number } }) => {
      const swipe = Math.abs(info.offset.x) * info.velocity.x;
      if (swipe < -3000) next();
      else if (swipe > 3000) prev();
    },
    [next, prev],
  );

  const blurDataURL = blurhashToDataURL(blurhash);
  const gradient =
    CATEGORY_GRADIENTS[category ?? ""] ??
    "from-primary via-violet-500 to-cyan-500";

  /* ── Empty / error → gradient fallback ───────────────────────────── */
  if (images.length === 0 || imgError) {
    return (
      <>
        <div className="aspect-[3/4] rounded-2xl shadow-xl overflow-hidden">
          <div
            className={`w-full h-full bg-gradient-to-br ${gradient} flex flex-col items-center justify-center`}
          >
            <div className="w-20 h-20 rounded-2xl bg-card/20 backdrop-blur-sm flex items-center justify-center mb-3">
              <span className="text-4xl font-bold text-white/80">
                {title?.charAt(0) ?? "?"}
              </span>
            </div>
            {categoryLabel && (
              <span className="text-sm text-white/60 font-medium">
                {categoryLabel}
              </span>
            )}
            <p className="text-xs text-white/35 mt-2">{t("imagePreparing")}</p>
          </div>
        </div>
        {demandBadge && (
          <div className="absolute top-4 right-4 z-10">{demandBadge}</div>
        )}
      </>
    );
  }

  /* ── Single image → plain <img> ──────────────────────────────────── */
  if (!hasMultiple) {
    return (
      <>
        <div className="aspect-[3/4] rounded-2xl shadow-xl overflow-hidden relative">
          <Image
            src={images[0]}
            alt={alt}
            fill
            sizes="(max-width: 1024px) 100vw, 40vw"
            priority
            className="object-cover"
            onError={() => setImgError(true)}
            {...(blurDataURL
              ? { placeholder: "blur" as const, blurDataURL }
              : {})}
          />
        </div>
        {demandBadge && (
          <div className="absolute top-4 right-4 z-10">{demandBadge}</div>
        )}
      </>
    );
  }

  /* ── Multiple images → animated gallery ──────────────────────────── */
  const slideVariants = {
    enter: (d: number) => ({ x: d > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d > 0 ? -80 : 80, opacity: 0 }),
  };

  return (
    <>
      {/* Main image */}
      <div className="aspect-[3/4] rounded-2xl shadow-xl overflow-hidden relative group">
        <AnimatePresence initial={false} custom={direction} mode="wait">
          <MotionImage
            key={current}
            src={images[current]}
            alt={`${alt} ${current + 1}`}
            fill
            sizes="(max-width: 1024px) 100vw, 40vw"
            className="object-cover"
            {...(blurDataURL
              ? { placeholder: "blur" as const, blurDataURL }
              : {})}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.4, ease: "easeInOut" }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.15}
            onDragEnd={handleDragEnd}
          />
        </AnimatePresence>

        {/* Nav arrows — visible on all screen sizes */}
        <button
          onClick={prev}
          className="absolute left-2 top-1/2 -translate-y-1/2 h-7 w-7 lg:h-9 lg:w-9 rounded-full bg-card/80 backdrop-blur-sm shadow-lg flex items-center justify-center text-primary opacity-70 lg:opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
          aria-label={t("prevImage")}
        >
          <ChevronLeft className="h-4 w-4 lg:h-5 lg:w-5" />
        </button>
        <button
          onClick={next}
          className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 lg:h-9 lg:w-9 rounded-full bg-card/80 backdrop-blur-sm shadow-lg flex items-center justify-center text-primary opacity-70 lg:opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
          aria-label={t("nextImage")}
        >
          <ChevronRight className="h-4 w-4 lg:h-5 lg:w-5" />
        </button>

        {/* Image counter */}
        <span className="absolute bottom-3 right-3 bg-black/50 backdrop-blur-sm text-white text-xs-plus rounded-full px-2.5 py-1 z-10">
          {current + 1} / {images.length}
        </span>
      </div>

      {/* Mobile dots */}
      <div className="flex justify-center gap-1.5 mt-3 lg:hidden">
        {images.map((src, i) => (
          <button
            key={`gallery-dot-${src}-${i}`}
            onClick={() => go(i)}
            aria-label={t("imageN", { n: i + 1 })}
            className="p-2 flex items-center justify-center"
          >
            <span
              className={`block rounded-full transition-all duration-300 ${
                i === current ? "w-6 h-2 bg-primary" : "w-2 h-2 bg-primary/30"
              }`}
            />
          </button>
        ))}
      </div>

      {/* Desktop thumbnails */}
      <div className="hidden lg:flex gap-2 mt-3">
        {images.map((src, i) => (
          <button
            key={`gallery-thumbnail-${src}-${i}`}
            onClick={() => go(i)}
            className={`w-16 h-16 rounded-xl overflow-hidden shrink-0 transition-all ${
              i === current
                ? "border-2 border-primary ring-2 ring-primary/20"
                : "border-2 border-transparent opacity-60 hover:opacity-100"
            }`}
          >
            <Image
              src={src}
              alt={t("thumbnailAlt", { alt: alt ?? "", n: i + 1 })}
              width={64}
              height={64}
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>

      {/* DemandBadge overlay */}
      {demandBadge && (
        <div className="absolute top-4 right-4 z-10">{demandBadge}</div>
      )}
    </>
  );
}
