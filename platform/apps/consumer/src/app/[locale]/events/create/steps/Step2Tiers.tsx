"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useFormContext, useFieldArray } from "react-hook-form";
import { Layers, Plus, Trash2, ChevronDown } from "lucide-react";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { Separator } from "@pickket/ui";
import { getOrganizerLabels } from "@pickket/lib";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import type { EventFormValues } from "../schema";

const DEFAULT_TIER = {
  name: "",
  capacity: 100,
  base_price: 0,
  sale_mode: "fixed_fcfs" as const,
  face_price: 0,
  min_price: 0,
  max_price_cap: 0,
  lottery_application_hours: 48,
  fanclub_discount_pct: 0,
  allow_group_tickets: true,
  max_group_size: 4,
};

export default function Step2Tiers() {
  const t = useTranslations("event.createStep2");
  const {
    register,
    watch,
    control,
    formState: { errors },
  } = useFormContext<EventFormValues>();

  const { fields, append, remove } = useFieldArray({
    control,
    name: "tiers",
  });

  const [expandedBidding, setExpandedBidding] = useState<Set<number>>(
    new Set(),
  );
  const [expandedViewTier, setExpandedViewTier] = useState<number | null>(null);

  const toggleBidding = (index: number) => {
    setExpandedBidding((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const tiers = watch("tiers");
  const totalSeats = tiers?.reduce(
    (acc, t) => acc + (Number(t.capacity) || 0),
    0,
  );

  const handleAppend = () => {
    if (fields.length >= 10) return;
    append(DEFAULT_TIER);
  };

  return (
    <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          {t("heading")}
        </h2>
        <Badge
          variant="secondary"
          className="bg-primary/10 text-primary font-semibold"
        >
          {t("totalSeats", { count: totalSeats ?? 0 })}
        </Badge>
      </div>

      {/* Array-level error */}
      {errors.tiers && !Array.isArray(errors.tiers) && errors.tiers.message && (
        <p className="text-xs text-red-500">{errors.tiers.message}</p>
      )}
      {errors.tiers?.root?.message && (
        <p className="text-xs text-red-500">{errors.tiers.root.message}</p>
      )}

      <div className="space-y-4">
        {fields.map((field, index) => {
          const saleMode = watch(`tiers.${index}.sale_mode`);
          const tierErrors = errors.tiers?.[index];

          return (
            <div
              key={field.id}
              className="border rounded-2xl p-4 space-y-4 transition-colors focus-within:border-primary"
            >
              {/* Tier header */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-primary">
                  {t("tierLabel", { index: index + 1 })}
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  disabled={fields.length <= 1}
                  className="text-red-500 hover:bg-red-50 rounded-lg p-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Name & Capacity */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label
                    htmlFor={`tiers.${index}.name`}
                    className="mb-1.5 block text-sm"
                  >
                    {t("tierName")}
                  </Label>
                  <Input
                    id={`tiers.${index}.name`}
                    {...register(`tiers.${index}.name`)}
                    placeholder={t("tierNamePlaceholder")}
                    className="rounded-xl bg-surface-dim"
                    aria-describedby={
                      tierErrors?.name ? `tiers.${index}.name-error` : undefined
                    }
                    aria-invalid={!!tierErrors?.name}
                  />
                  {tierErrors?.name && (
                    <p
                      id={`tiers.${index}.name-error`}
                      className="text-xs text-red-500 mt-1"
                      role="alert"
                    >
                      {tierErrors.name.message}
                    </p>
                  )}
                </div>
                <div>
                  <Label
                    htmlFor={`tiers.${index}.capacity`}
                    className="mb-1.5 block text-sm"
                  >
                    {t("capacity")}
                  </Label>
                  <Input
                    id={`tiers.${index}.capacity`}
                    type="number"
                    {...register(`tiers.${index}.capacity`)}
                    placeholder="100"
                    className="rounded-xl bg-surface-dim"
                    aria-describedby={
                      tierErrors?.capacity
                        ? `tiers.${index}.capacity-error`
                        : undefined
                    }
                    aria-invalid={!!tierErrors?.capacity}
                  />
                  {tierErrors?.capacity && (
                    <p
                      id={`tiers.${index}.capacity-error`}
                      className="text-xs text-red-500 mt-1"
                      role="alert"
                    >
                      {tierErrors.capacity.message}
                    </p>
                  )}
                </div>
              </div>

              {/* Base price & Sale mode */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label
                    htmlFor={`tiers.${index}.base_price`}
                    className="mb-1.5 block text-sm"
                  >
                    {t("basePrice")}
                  </Label>
                  <Input
                    id={`tiers.${index}.base_price`}
                    type="number"
                    {...register(`tiers.${index}.base_price`)}
                    placeholder="0"
                    className="rounded-xl bg-surface-dim"
                    aria-describedby={
                      tierErrors?.base_price
                        ? `tiers.${index}.base_price-error`
                        : undefined
                    }
                    aria-invalid={!!tierErrors?.base_price}
                  />
                  {tierErrors?.base_price && (
                    <p
                      id={`tiers.${index}.base_price-error`}
                      className="text-xs text-red-500 mt-1"
                      role="alert"
                    >
                      {tierErrors.base_price.message}
                    </p>
                  )}
                </div>
                <div>
                  <Label
                    htmlFor={`tiers.${index}.sale_mode`}
                    className="mb-1.5 block text-sm"
                  >
                    {t("saleMode")}
                  </Label>
                  <select
                    id={`tiers.${index}.sale_mode`}
                    {...register(`tiers.${index}.sale_mode`)}
                    className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {Object.entries(SALE_MODE_LABELS).map(([value, meta]) => (
                      <option key={value} value={value}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                  {watch(`tiers.${index}.sale_mode`) === "lottery" && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("saleModeHintLottery")}
                    </p>
                  )}
                  {(!watch(`tiers.${index}.sale_mode`) ||
                    watch(`tiers.${index}.sale_mode`) === "fixed_fcfs") && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("saleModeHintFcfs")}
                    </p>
                  )}
                </div>
              </div>

              <Separator />

              {/* Face price (always shown) */}
              <div>
                <Label
                  htmlFor={`tiers.${index}.face_price`}
                  className="mb-1.5 block text-sm"
                >
                  {t("facePrice")}
                </Label>
                <Input
                  id={`tiers.${index}.face_price`}
                  type="number"
                  {...register(`tiers.${index}.face_price`)}
                  placeholder="0"
                  className="rounded-xl bg-surface-dim"
                  aria-describedby={
                    tierErrors?.face_price
                      ? `tiers.${index}.face_price-error`
                      : undefined
                  }
                  aria-invalid={!!tierErrors?.face_price}
                />
                {tierErrors?.face_price && (
                  <p
                    id={`tiers.${index}.face_price-error`}
                    className="text-xs text-red-500 mt-1"
                    role="alert"
                  >
                    {tierErrors.face_price.message}
                  </p>
                )}
              </div>

              {/* Lottery fields */}
              {saleMode === "lottery" && (
                <div>
                  <Label
                    htmlFor={`tiers.${index}.lottery_application_hours`}
                    className="mb-1.5 block text-sm"
                  >
                    {t("lotteryHours")}
                  </Label>
                  <Input
                    id={`tiers.${index}.lottery_application_hours`}
                    type="number"
                    {...register(`tiers.${index}.lottery_application_hours`)}
                    placeholder="48"
                    className="rounded-xl bg-surface-dim"
                  />
                  {tierErrors?.lottery_application_hours && (
                    <p className="text-xs text-red-500 mt-1">
                      {tierErrors.lottery_application_hours.message}
                    </p>
                  )}
                </div>
              )}

              <Separator />

              {/* Group tickets (always shown) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                <div className="flex items-center gap-3">
                  <input
                    id={`tiers.${index}.allow_group_tickets`}
                    type="checkbox"
                    {...register(`tiers.${index}.allow_group_tickets`)}
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <Label
                    htmlFor={`tiers.${index}.allow_group_tickets`}
                    className="text-sm cursor-pointer"
                  >
                    {t("allowGroupTickets")}
                  </Label>
                </div>
                {watch(`tiers.${index}.allow_group_tickets`) && (
                  <div>
                    <Label
                      htmlFor={`tiers.${index}.max_group_size`}
                      className="mb-1.5 block text-sm"
                    >
                      {t("maxGroupSize")}
                    </Label>
                    <Input
                      id={`tiers.${index}.max_group_size`}
                      type="number"
                      {...register(`tiers.${index}.max_group_size`)}
                      placeholder="4"
                      className="rounded-xl bg-surface-dim"
                    />
                    {tierErrors?.max_group_size && (
                      <p className="text-xs text-red-500 mt-1">
                        {tierErrors.max_group_size.message}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Collapsible bidding period */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleBidding(index)}
                  className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors w-full"
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      expandedBidding.has(index) ? "rotate-180" : ""
                    }`}
                  />
                  {t("biddingPeriod")}
                </button>

                {expandedBidding.has(index) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                    <div>
                      <Label
                        htmlFor={`tiers.${index}.bidding_opens_at`}
                        className="mb-1.5 block text-sm"
                      >
                        {t("biddingOpens")}
                      </Label>
                      <Input
                        id={`tiers.${index}.bidding_opens_at`}
                        type="datetime-local"
                        {...register(`tiers.${index}.bidding_opens_at`)}
                        className="rounded-xl bg-surface-dim"
                      />
                      {tierErrors?.bidding_opens_at && (
                        <p className="text-xs text-red-500 mt-1">
                          {tierErrors.bidding_opens_at.message}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label
                        htmlFor={`tiers.${index}.bidding_closes_at`}
                        className="mb-1.5 block text-sm"
                      >
                        {t("biddingCloses")}
                      </Label>
                      <Input
                        id={`tiers.${index}.bidding_closes_at`}
                        type="datetime-local"
                        {...register(`tiers.${index}.bidding_closes_at`)}
                        className="rounded-xl bg-surface-dim"
                      />
                      {tierErrors?.bidding_closes_at && (
                        <p className="text-xs text-red-500 mt-1">
                          {tierErrors.bidding_closes_at.message}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* View metadata (optional) */}
              <div className="border-t border-border/60 mt-4 pt-3">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedViewTier(
                      expandedViewTier === index ? null : index,
                    )
                  }
                  className="flex items-center justify-between w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>{t("viewInfo")}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${expandedViewTier === index ? "rotate-180" : ""}`}
                  />
                </button>

                {expandedViewTier === index && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label
                        htmlFor={`tiers.${index}.position_label`}
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        {t("positionLabel")}
                      </label>
                      <input
                        id={`tiers.${index}.position_label`}
                        type="text"
                        placeholder={t("positionLabelPlaceholder")}
                        {...register(`tiers.${index}.position_label` as const)}
                        className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`tiers.${index}.view_description`}
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        {t("viewDescription")}
                      </label>
                      <textarea
                        id={`tiers.${index}.view_description`}
                        placeholder={t("viewDescriptionPlaceholder")}
                        {...register(
                          `tiers.${index}.view_description` as const,
                        )}
                        className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-sm resize-none"
                        rows={2}
                        maxLength={300}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor={`tiers.${index}.distance_from_stage`}
                          className="text-xs font-medium text-muted-foreground mb-1 block"
                        >
                          {t("distanceFromStage", {
                            ref:
                              getOrganizerLabels(watch("category"))
                                .distanceRefLabel ?? "",
                          })}
                        </label>
                        <input
                          id={`tiers.${index}.distance_from_stage`}
                          type="number"
                          placeholder="15"
                          {...register(
                            `tiers.${index}.distance_from_stage` as const,
                          )}
                          className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-sm"
                          min={0}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`tiers.${index}.view_rating`}
                          className="text-xs font-medium text-muted-foreground mb-1 block"
                        >
                          {t("viewRating")}
                        </label>
                        <select
                          id={`tiers.${index}.view_rating`}
                          {...register(`tiers.${index}.view_rating` as const)}
                          className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-sm"
                        >
                          <option value="">{t("viewRatingSelect")}</option>
                          <option value="5">★★★★★ {t("viewRating5")}</option>
                          <option value="4">★★★★☆ {t("viewRating4")}</option>
                          <option value="3">★★★☆☆ {t("viewRating3")}</option>
                          <option value="2">★★☆☆☆ {t("viewRating2")}</option>
                          <option value="1">★☆☆☆☆ {t("viewRating1")}</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor={`tiers.${index}.view_image_url`}
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        {t("viewImageUrl")}
                      </label>
                      <input
                        id={`tiers.${index}.view_image_url`}
                        type="url"
                        placeholder="https://example.com/view-photo.jpg"
                        {...register(`tiers.${index}.view_image_url` as const)}
                        className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-sm"
                      />
                      {watch(`tiers.${index}.view_image_url` as const) && (
                        <div className="mt-2 relative w-full aspect-video rounded-lg overflow-hidden bg-muted">
                          <Image
                            src={
                              watch(`tiers.${index}.view_image_url` as const) ||
                              ""
                            }
                            alt={t("viewImageAlt")}
                            fill
                            className="w-full h-full object-cover"
                            sizes="(max-width: 768px) 100vw, 768px"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add tier button */}
      {fields.length >= 10 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          {t("maxTiersReached")}
        </p>
      ) : (
        <button
          type="button"
          onClick={handleAppend}
          className="w-full border-dashed border-2 border-border hover:border-primary rounded-2xl p-4 flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t("addTier")}
        </button>
      )}
    </div>
  );
}
