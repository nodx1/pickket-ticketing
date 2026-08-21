"use client";

import { useState } from "react";
import { useFormContext } from "react-hook-form";
import Image from "next/image";
import { Image as ImageIcon, Star, Tag, Eye } from "lucide-react";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { Separator } from "@pickket/ui";
import { getDomainLabels, getOrganizerLabels } from "@pickket/lib";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import { useTranslations } from "next-intl";
import type { EventFormValues } from "../schema";

function formatKoDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    return new Date(value).toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function Step5Media() {
  const t = useTranslations("event.createStep5");

  const REMAINDER_STRATEGY_LABELS: Record<string, string> = {
    discount_fcfs: t("remainderStrategy.discountFcfs"),
    fcfs: t("remainderStrategy.fcfs"),
    lottery: t("remainderStrategy.lottery"),
    none: t("remainderStrategy.none"),
  };

  const {
    register,
    watch,
    formState: { errors },
  } = useFormContext<EventFormValues>();

  const [posterError, setPosterError] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  const imageUrl = watch("image_url");
  const thumbnailUrl = watch("thumbnail_url");
  const tags = watch("tags");
  const title = watch("title");
  const category = watch("category");
  const subCategory = watch("sub_category");
  const artistName = watch("artist_name");
  const venue = watch("venue");
  const locationCity = watch("location_city");
  const eventDate = watch("event_date");
  const biddingOpensAt = watch("bidding_opens_at");
  const biddingClosesAt = watch("bidding_closes_at");
  const tiers = watch("tiers");
  const minPrice = watch("min_price");
  const maxPrice = watch("max_price");
  const totalSeats = watch("total_seats");
  const resaleEnabled = watch("resale_enabled");
  const remainderStrategy = watch("remainder_strategy");

  const parsedTags = tags
    ? tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      {/* Section 1: 미디어 */}
      <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <ImageIcon className="h-5 w-5 text-primary" />
          {t("sectionMedia")}
        </h2>

        {/* 포스터 이미지 URL */}
        <div>
          <Label
            htmlFor="image_url"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <ImageIcon className="h-3.5 w-3.5" /> {t("labelPosterUrl")}
          </Label>
          <Input
            id="image_url"
            {...register("image_url", {
              onChange: () => setPosterError(false),
            })}
            placeholder="https://example.com/poster.jpg"
            className="rounded-xl bg-surface-dim"
          />
          {errors.image_url && (
            <p className="text-xs text-red-500 mt-1">
              {errors.image_url.message}
            </p>
          )}
          {imageUrl && !posterError && (
            <Image
              src={imageUrl}
              alt={t("altPoster")}
              width={1200}
              height={900}
              unoptimized
              className="max-h-48 w-full rounded-xl object-cover mt-2"
              onError={() => setPosterError(true)}
            />
          )}
        </div>

        {/* 썸네일 URL */}
        <div>
          <Label
            htmlFor="thumbnail_url"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <ImageIcon className="h-3.5 w-3.5" /> {t("labelThumbnailUrl")}
          </Label>
          <Input
            id="thumbnail_url"
            {...register("thumbnail_url", {
              onChange: () => setThumbError(false),
            })}
            placeholder="https://example.com/thumb.jpg"
            className="rounded-xl bg-surface-dim"
          />
          {errors.thumbnail_url && (
            <p className="text-xs text-red-500 mt-1">
              {errors.thumbnail_url.message}
            </p>
          )}
          {thumbnailUrl && !thumbError && (
            <Image
              src={thumbnailUrl}
              alt={t("altThumbnail")}
              width={320}
              height={180}
              unoptimized
              className="h-20 w-auto rounded-lg object-cover mt-2"
              onError={() => setThumbError(true)}
            />
          )}
        </div>

        {/* 태그 */}
        <div>
          <Label htmlFor="tags" className="flex items-center gap-1.5 mb-1.5">
            <Tag className="h-3.5 w-3.5" /> {t("labelTags")}
          </Label>
          <Input
            id="tags"
            {...register("tags")}
            placeholder={t("placeholderTags")}
            className="rounded-xl bg-surface-dim"
          />
          {parsedTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {parsedTags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* 추천 이벤트 */}
        <div className="flex items-center gap-2">
          <input
            id="is_featured"
            type="checkbox"
            {...register("is_featured")}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <Label
            htmlFor="is_featured"
            className="flex items-center gap-1.5 cursor-pointer"
          >
            <Star className="h-3.5 w-3.5 text-yellow-500" /> {t("labelFeatured")}
          </Label>
        </div>
      </div>

      <Separator />

      {/* Section 2: 최종 미리보기 */}
      <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Eye className="h-5 w-5 text-primary" />
          {t("sectionPreview")}
        </h2>

        <div className="bg-surface-dim rounded-xl p-4 space-y-3">
          {/* 제목 */}
          <div>
            <span className="text-sm text-muted-foreground">{t("previewTitle")}</span>
            <p className="text-sm font-medium">{title || t("previewTitleEmpty")}</p>
          </div>

          {/* 카테고리 */}
          <div>
            <span className="text-sm text-muted-foreground">{t("previewCategory")}</span>
            <p className="text-sm font-medium">
              {category || t("previewNotSelected")}
              {subCategory ? ` > ${subCategory}` : ""}
            </p>
          </div>

          {/* 아티스트/팀/작품 등 */}
          <div>
            <span className="text-sm text-muted-foreground">
              {getDomainLabels(category).subjectLabel}
            </span>
            <p className="text-sm font-medium">{artistName || t("previewNotSpecified")}</p>
          </div>

          {/* 장소 */}
          <div>
            <span className="text-sm text-muted-foreground">{t("previewVenue")}</span>
            <p className="text-sm font-medium">
              {venue || t("previewNotEntered")}
              {locationCity ? ` (${locationCity})` : ""}
            </p>
          </div>

          <Separator />

          {/* 일정 */}
          <div>
            <span className="text-sm text-muted-foreground font-semibold">
              {t("previewSchedule")}
            </span>
            <div className="mt-1 space-y-1">
              <p className="text-sm">
                <span className="text-muted-foreground">
                  {getOrganizerLabels(category).eventLabel}{t("previewDateSuffix")}
                </span>{" "}
                <span className="font-medium">{formatKoDate(eventDate, t("previewNotSet"))}</span>
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">{t("previewBidding")}</span>{" "}
                <span className="font-medium">
                  {formatKoDate(biddingOpensAt, t("previewNotSet"))} ~{" "}
                  {formatKoDate(biddingClosesAt, t("previewNotSet"))}
                </span>
              </p>
            </div>
          </div>

          <Separator />

          {/* 좌석등급 */}
          <div>
            <span className="text-sm text-muted-foreground font-semibold">
              {t("previewTiers", { count: tiers?.length ?? 0 })}
            </span>
            <div className="mt-1 space-y-1">
              {tiers && tiers.length > 0 ? (
                tiers.map((tier, idx) => (
                  <p
                    key={`${tier.name}-${tier.sale_mode}-${idx}`}
                    className="text-sm font-medium"
                  >
                    {tier.name || t("previewTierNoName")} | {tier.capacity ?? 0}{t("previewSeatSuffix")} |{" "}
                    {(tier.base_price ?? 0).toLocaleString()}{t("previewPriceSuffix")} |{" "}
                    {SALE_MODE_LABELS[tier.sale_mode]?.label || tier.sale_mode}
                  </p>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">{t("previewTiersEmpty")}</p>
              )}
            </div>
          </div>

          <Separator />

          {/* 가격 & 좌석 */}
          <div>
            <span className="text-sm text-muted-foreground">{t("previewPrice")}</span>
            <p className="text-sm font-medium">
              {(minPrice ?? 0).toLocaleString()} ~{" "}
              {maxPrice ? maxPrice.toLocaleString() : t("previewNoLimit")} {t("previewPriceSuffix")}
            </p>
          </div>

          <div>
            <span className="text-sm text-muted-foreground">{t("previewTotalSeats")}</span>
            <p className="text-sm font-medium">
              {(totalSeats ?? 0).toLocaleString()}{t("previewSeatSuffix")}
            </p>
          </div>

          <Separator />

          {/* 리세일 & 잔여석 */}
          <div>
            <span className="text-sm text-muted-foreground">{t("previewResale")}</span>
            <p className="text-sm font-medium">
              {resaleEnabled ? t("previewResaleAllowed") : t("previewResaleDisabled")}
            </p>
          </div>

          <div>
            <span className="text-sm text-muted-foreground">{t("previewRemainder")}</span>
            <p className="text-sm font-medium">
              {REMAINDER_STRATEGY_LABELS[remainderStrategy] ||
                remainderStrategy ||
                t("previewNotSet")}
            </p>
          </div>

          {/* 이미지 미리보기 */}
          {imageUrl && !posterError && (
            <>
              <Separator />
              <div>
                <span className="text-sm text-muted-foreground">{t("previewPosterLabel")}</span>
                <Image
                  src={imageUrl}
                  alt={t("altPosterPreview")}
                  width={1200}
                  height={900}
                  unoptimized
                  className="max-h-48 w-full rounded-xl object-cover mt-2"
                  onError={() => setPosterError(true)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
