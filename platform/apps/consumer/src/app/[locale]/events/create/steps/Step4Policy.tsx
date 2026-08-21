"use client";

import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { Repeat, Package, Building2, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Separator } from "@pickket/ui";
import { getDomainLabels, getOrganizerLabels } from "@pickket/lib";
import type { EventFormValues } from "../schema";

export default function Step4Policy() {
  const t = useTranslations("event.step4Policy");
  const {
    register,
    watch,
    formState: { errors },
  } = useFormContext<EventFormValues>();

  const [publicOpen, setPublicOpen] = useState(false);

  const resaleEnabled = watch("resale_enabled");
  const resaleMaxMarkup = watch("resale_max_markup_pct");
  const resaleRoyalty = watch("resale_royalty_pct");
  const remainderStrategy = watch("remainder_strategy");

  return (
    <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
      {/* ───── Section 1: 리세일 설정 ───── */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Repeat className="h-5 w-5 text-primary" />
          {t("resaleTitle")}
        </h2>

        {/* 리세일 허용 토글 */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            {...register("resale_enabled")}
            className="h-4 w-4 rounded accent-primary"
          />
          <span className="text-sm font-medium">{t("resaleAllowed")}</span>
        </label>

        {resaleEnabled && (
          <div className="space-y-4 pl-1">
            {/* 마크업 & 로열티 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="resale_max_markup_pct" className="mb-1.5 block">
                  {t("maxMarkupLabel")}
                </Label>
                <Input
                  id="resale_max_markup_pct"
                  type="number"
                  {...register("resale_max_markup_pct")}
                  className="rounded-xl bg-surface-dim"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("maxMarkupHint", { pct: resaleMaxMarkup ?? 0 })}
                </p>
                {errors.resale_max_markup_pct && (
                  <p className="text-xs text-red-500 mt-1">
                    {errors.resale_max_markup_pct.message}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="resale_royalty_pct" className="mb-1.5 block">
                  {getDomainLabels(watch("category")).subjectLabel} {t("royaltyLabel")}
                </Label>
                <Input
                  id="resale_royalty_pct"
                  type="number"
                  {...register("resale_royalty_pct")}
                  className="rounded-xl bg-surface-dim"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("royaltyHint", { pct: resaleRoyalty ?? 0 })}
                </p>
                {errors.resale_royalty_pct && (
                  <p className="text-xs text-red-500 mt-1">
                    {errors.resale_royalty_pct.message}
                  </p>
                )}
              </div>
            </div>

            {/* 리세일 기간 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="resale_opens_at" className="mb-1.5 block">
                  {t("resaleOpensAt")}
                </Label>
                <Input
                  id="resale_opens_at"
                  type="datetime-local"
                  {...register("resale_opens_at")}
                  className="rounded-xl bg-surface-dim"
                />
              </div>

              <div>
                <Label htmlFor="resale_closes_at" className="mb-1.5 block">
                  {t("resaleClosesAt")}
                </Label>
                <Input
                  id="resale_closes_at"
                  type="datetime-local"
                  {...register("resale_closes_at")}
                  className="rounded-xl bg-surface-dim"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <Separator />

      {/* ───── Section 2: 잔여석 정책 ───── */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Package className="h-5 w-5 text-primary" />
          {t("remainderTitle")}
        </h2>

        {/* 잔여석 처리 전략 */}
        <div>
          <Label htmlFor="remainder_strategy" className="mb-1.5 block">
            {t("remainderStrategyLabel")}
          </Label>
          <select
            id="remainder_strategy"
            {...register("remainder_strategy")}
            className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="discount_fcfs">{t("strategyDiscountFcfs")}</option>
            <option value="fcfs">{t("strategyFcfs")}</option>
            <option value="lottery">{t("strategyLottery")}</option>
            <option value="none">{t("strategyNone")}</option>
          </select>
          {errors.remainder_strategy && (
            <p className="text-xs text-red-500 mt-1">
              {errors.remainder_strategy.message}
            </p>
          )}
        </div>

        {remainderStrategy !== "none" && (
          <div>
            <Label htmlFor="remainder_trigger_hours" className="mb-1.5 block">
              {t("remainderTriggerLabel", {
                eventLabel: getOrganizerLabels(watch("category")).eventLabel ?? "",
              })}
            </Label>
            <Input
              id="remainder_trigger_hours"
              type="number"
              {...register("remainder_trigger_hours")}
              className="rounded-xl bg-surface-dim"
            />
            {errors.remainder_trigger_hours && (
              <p className="text-xs text-red-500 mt-1">
                {errors.remainder_trigger_hours.message}
              </p>
            )}
          </div>
        )}

        {remainderStrategy === "discount_fcfs" && (
          <div>
            <Label
              htmlFor="remainder_step_interval_min"
              className="mb-1.5 block"
            >
              {t("discountIntervalLabel")}
            </Label>
            <Input
              id="remainder_step_interval_min"
              type="number"
              {...register("remainder_step_interval_min")}
              className="rounded-xl bg-surface-dim"
            />
            {errors.remainder_step_interval_min && (
              <p className="text-xs text-red-500 mt-1">
                {errors.remainder_step_interval_min.message}
              </p>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* ───── Section 3: 공공/특수 설정 (collapsible) ───── */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setPublicOpen((prev) => !prev)}
          className="w-full flex items-center justify-between text-lg font-bold"
        >
          <span className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            {t("publicSectionTitle")}
          </span>
          <ChevronDown
            className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${
              publicOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {publicOpen && (
          <div className="space-y-4 pl-1">
            {/* is_public_sector */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                {...register("is_public_sector")}
                className="h-4 w-4 rounded accent-primary"
              />
              <span className="text-sm font-medium">{t("isPublicSector")}</span>
            </label>

            {/* is_free */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                {...register("is_free")}
                className="h-4 w-4 rounded accent-primary"
              />
              <span className="text-sm font-medium">{t("isFree")}</span>
            </label>

            {/* require_checkin */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                {...register("require_checkin")}
                className="h-4 w-4 rounded accent-primary"
              />
              <span className="text-sm font-medium">{t("requireCheckin")}</span>
            </label>

            {/* locality_restricted */}
            <div>
              <Label htmlFor="locality_restricted" className="mb-1.5 block">
                {t("localityRestrictedLabel")}
              </Label>
              <Input
                id="locality_restricted"
                type="text"
                {...register("locality_restricted")}
                placeholder={t("localityRestrictedPlaceholder")}
                className="rounded-xl bg-surface-dim"
              />
            </div>

            {/* deposit_amount */}
            <div>
              <Label htmlFor="deposit_amount" className="mb-1.5 block">
                {t("depositAmountLabel")}
              </Label>
              <Input
                id="deposit_amount"
                type="number"
                {...register("deposit_amount")}
                className="rounded-xl bg-surface-dim"
              />
              {errors.deposit_amount && (
                <p className="text-xs text-red-500 mt-1">
                  {errors.deposit_amount.message}
                </p>
              )}
            </div>

            {/* no_show_policy */}
            <div>
              <Label htmlFor="no_show_policy" className="mb-1.5 block">
                {t("noShowPolicyLabel")}
              </Label>
              <select
                id="no_show_policy"
                {...register("no_show_policy")}
                className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="refund">{t("noShowRefund")}</option>
                <option value="forfeit">{t("noShowForfeit")}</option>
                <option value="partial">{t("noShowPartial")}</option>
              </select>
              {errors.no_show_policy && (
                <p className="text-xs text-red-500 mt-1">
                  {errors.no_show_policy.message}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
