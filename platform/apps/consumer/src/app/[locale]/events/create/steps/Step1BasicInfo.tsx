"use client";

import { useState, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import { Sparkles, Music, MapPin, Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import {
  CATEGORIES,
  SUB_CATEGORIES,
  CITIES,
  type CategorySlug,
} from "@pickket/lib";
import { getVenues } from "@pickket/lib/api";
import { getDomainLabels } from "@pickket/lib";
import type { EventFormValues } from "../schema";

export default function Step1BasicInfo() {
  const t = useTranslations("event.createStep1");
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<EventFormValues>();

  const [venues, setVenues] = useState<Array<{id: string; name: string; city: string}>>([]);

  useEffect(() => {
    getVenues().then(res => setVenues(res.data || [])).catch(() => {});
  }, []);

  const category = watch("category");
  const domainLabels = getDomainLabels(category);
  const subOptions = category
    ? SUB_CATEGORIES[category as CategorySlug] || []
    : [];

  return (
    <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
      <h2 className="text-lg font-bold flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        {t("heading")}
      </h2>

      {/* 제목 */}
      <div>
        <Label
          htmlFor="title"
          className="flex items-center gap-1.5 mb-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" /> {t("titleLabel")}
        </Label>
        <Input
          id="title"
          {...register("title")}
          placeholder={t("titlePlaceholder")}
          className="rounded-xl bg-surface-dim"
        />
        {errors.title && (
          <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>
        )}
      </div>

      {/* 설명 */}
      <div>
        <Label htmlFor="description" className="mb-1.5 block">
          {t("descriptionLabel")}
        </Label>
        <textarea
          id="description"
          {...register("description")}
          rows={3}
          className="flex w-full rounded-xl bg-surface-dim px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground border border-input ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>

      {/* 카테고리 & 세부 카테고리 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label
            htmlFor="category"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <Tag className="h-3.5 w-3.5" /> {t("categoryLabel")}
          </Label>
          <select
            id="category"
            {...register("category")}
            onChange={(e) => {
              setValue("category", e.target.value);
              setValue("sub_category", "");
            }}
            className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="">{t("categoryPlaceholder")}</option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
          {errors.category && (
            <p className="text-xs text-red-500 mt-1">
              {errors.category.message}
            </p>
          )}
        </div>
        {subOptions.length > 0 && (
          <div>
            <Label htmlFor="sub_category" className="mb-1.5 block">
              {t("subCategoryLabel")}
            </Label>
            <select
              id="sub_category"
              {...register("sub_category")}
              className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="">{t("subCategoryPlaceholder")}</option>
              {subOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* 아티스트 */}
      <div>
        <Label
          htmlFor="artist_name"
          className="flex items-center gap-1.5 mb-1.5"
        >
          <Music className="h-3.5 w-3.5" /> {t("artistLabel", { subject: domainLabels.subjectLabel ?? "" })}
        </Label>
        <Input
          id="artist_name"
          {...register("artist_name")}
          placeholder={domainLabels.placeholderName}
          className="rounded-xl bg-surface-dim"
        />
      </div>

      {/* 장소 */}
      <div>
        <Label
          htmlFor="venue"
          className="flex items-center gap-1.5 mb-1.5"
        >
          <MapPin className="h-3.5 w-3.5" /> {t("venueLabel")}
        </Label>
        <Input
          id="venue"
          {...register("venue")}
          list="venue-list"
          placeholder={t("venuePlaceholder")}
          className="rounded-xl bg-surface-dim"
          onChange={(e) => {
            register("venue").onChange(e);
            const match = venues.find(v => v.name === e.target.value);
            if (match && match.city) {
              setValue("location_city", match.city);
            }
          }}
        />
        <datalist id="venue-list">
          {venues.map((v) => (
            <option key={v.id} value={v.name}>
              {v.city} — {v.name}
            </option>
          ))}
        </datalist>
        {errors.venue && (
          <p className="text-xs text-red-500 mt-1">{errors.venue.message}</p>
        )}
      </div>

      {/* 지역 */}
      <div>
        <Label htmlFor="location_city" className="mb-1.5 block">
          {t("cityLabel")}
        </Label>
        <select
          id="location_city"
          {...register("location_city")}
          className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="">{t("cityPlaceholder")}</option>
          {CITIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
