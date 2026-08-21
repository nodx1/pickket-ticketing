"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";
import {
  Calendar,
  CreditCard,
  Users,
  ShieldCheck,
  Timer,
  ChevronDown,
} from "lucide-react";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Separator } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { AGE_RESTRICTIONS } from "@pickket/lib";
import { getOrganizerLabels } from "@pickket/lib";
import type { EventFormValues } from "../schema";

export default function Step3Sales() {
  const t = useTranslations("event.createStep3");
  const {
    register,
    watch,
    formState: { errors },
  } = useFormContext<EventFormValues>();

  const [multiOpen, setMultiOpen] = useState(false);

  const formData = watch();
  const orgLabels = getOrganizerLabels(formData.category);

  const tiers = watch("tiers");
  const tierSum = Array.isArray(tiers)
    ? tiers.reduce((sum, t) => sum + (Number(t.capacity) || 0), 0)
    : 0;

  const priceCapMultiplier = watch("price_cap_multiplier") ?? 2.0;

  return (
    <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
      {/* ── Section 1: 일정 ── */}
      <h2 className="text-lg font-bold flex items-center gap-2">
        <Calendar className="h-5 w-5 text-primary" />
        {t("scheduleTitle")}
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 이벤트 일시 */}
        <div>
          <Label
            htmlFor="event_date"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <Calendar className="h-3.5 w-3.5" /> {t("eventDateLabel")}
          </Label>
          <Input
            id="event_date"
            type="datetime-local"
            {...register("event_date")}
            className="rounded-xl bg-surface-dim"
          />
          <p className="text-xs text-muted-foreground mt-0.5">{t("kstHint")}</p>
          {errors.event_date && (
            <p className="text-xs text-red-500 mt-1">
              {errors.event_date.message}
            </p>
          )}
        </div>

        {/* 응모 시작 */}
        <div>
          <Label
            htmlFor="bidding_opens_at"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <Timer className="h-3.5 w-3.5" /> {t("biddingOpensLabel")}
          </Label>
          <Input
            id="bidding_opens_at"
            type="datetime-local"
            {...register("bidding_opens_at")}
            className="rounded-xl bg-surface-dim"
          />
          <p className="text-xs text-muted-foreground mt-0.5">{t("kstHint")}</p>
          {errors.bidding_opens_at && (
            <p className="text-xs text-red-500 mt-1">
              {errors.bidding_opens_at.message}
            </p>
          )}
        </div>

        {/* 응모 마감 */}
        <div>
          <Label
            htmlFor="bidding_closes_at"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <Timer className="h-3.5 w-3.5" /> {t("biddingClosesLabel")}
          </Label>
          <Input
            id="bidding_closes_at"
            type="datetime-local"
            {...register("bidding_closes_at")}
            className="rounded-xl bg-surface-dim"
          />
          <p className="text-xs text-muted-foreground mt-0.5">{t("kstHint")}</p>
          {errors.bidding_closes_at && (
            <p className="text-xs text-red-500 mt-1">
              {errors.bidding_closes_at.message}
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("scheduleOrderHint")}
      </p>

      <Separator />

      {/* ── Section 2: 가격 & 규제 ── */}
      <h2 className="text-lg font-bold flex items-center gap-2">
        <CreditCard className="h-5 w-5 text-primary" />
        {t("pricingTitle")}
      </h2>

      {/* Row 1: 총 좌석 수 / 최소 가격 / 최대 가격 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label
            htmlFor="total_seats"
            className="flex items-center gap-1.5 mb-1.5"
          >
            <Users className="h-3.5 w-3.5" /> {t("totalSeatsLabel")}
            <Badge variant="secondary" className="ml-1 text-xs">
              {t("tierSumBadge", { count: tierSum ?? 0 })}
            </Badge>
          </Label>
          <Input
            id="total_seats"
            type="number"
            {...register("total_seats")}
            readOnly
            className="rounded-xl bg-surface-dim opacity-70 cursor-not-allowed"
          />
          {errors.total_seats && (
            <p className="text-xs text-red-500 mt-1">
              {errors.total_seats.message}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="min_price" className="mb-1.5 block">
            {t("minPriceLabel")}
          </Label>
          <Input
            id="min_price"
            type="number"
            {...register("min_price")}
            className="rounded-xl bg-surface-dim"
          />
        </div>

        <div>
          <Label htmlFor="max_price" className="mb-1.5 block">
            {t("maxPriceLabel")}
          </Label>
          <Input
            id="max_price"
            type="number"
            {...register("max_price")}
            className="rounded-xl bg-surface-dim"
          />
        </div>
      </div>

      {/* Row 2: 관람 등급 / 공연 시간 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="age_restriction" className="mb-1.5 block">
            {t("ageRestrictionLabel")}
          </Label>
          <select
            id="age_restriction"
            {...register("age_restriction")}
            className="flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="">{t("selectPlaceholder")}</option>
            {AGE_RESTRICTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="duration_minutes" className="mb-1.5 block">
            {orgLabels.durationLabel} {t("durationUnit")}
          </Label>
          <Input
            id="duration_minutes"
            type="number"
            {...register("duration_minutes")}
            className="rounded-xl bg-surface-dim"
          />
        </div>
      </div>

      {/* Row 3: 가격 상한 배수 / 본인인증 필수 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="price_cap_multiplier" className="mb-1.5 block">
            {t("priceCapMultiplierLabel")}
          </Label>
          <Input
            id="price_cap_multiplier"
            type="number"
            step={0.1}
            {...register("price_cap_multiplier")}
            className="rounded-xl bg-surface-dim"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("priceCapHint", { multiplier: priceCapMultiplier ?? 2.0 })}
          </p>
        </div>

        <div className="flex items-center gap-2 pt-6">
          <input
            id="require_identity_verification"
            type="checkbox"
            {...register("require_identity_verification")}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <Label
            htmlFor="require_identity_verification"
            className="flex items-center gap-1.5 cursor-pointer"
          >
            <ShieldCheck className="h-3.5 w-3.5" /> {t("identityVerificationLabel")}
          </Label>
        </div>
      </div>

      <Separator />

      {/* ── Section 3: 멀티세션 설정 (collapsible) ── */}
      <button
        type="button"
        onClick={() => setMultiOpen((prev) => !prev)}
        className="flex items-center gap-2 text-lg font-bold w-full text-left"
      >
        <Users className="h-5 w-5 text-primary" />
        {t("multiSessionTitle")}
        <ChevronDown
          className={`h-4 w-4 ml-auto transition-transform ${
            multiOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {multiOpen && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1인 최대 당첨 횟수 */}
          <div>
            <Label htmlFor="multi_max_wins_per_user" className="mb-1.5 block">
              {t("multiMaxWinsLabel")}
            </Label>
            <Input
              id="multi_max_wins_per_user"
              type="number"
              {...register("multi_max_wins_per_user")}
              className="rounded-xl bg-surface-dim"
            />
          </div>

          {/* 낙첨 보너스 가중치 */}
          <div>
            <Label
              htmlFor="multi_loser_bonus_weight"
              className="mb-1.5 block"
            >
              {t("multiLoserBonusLabel")}
            </Label>
            <Input
              id="multi_loser_bonus_weight"
              type="number"
              step={0.01}
              {...register("multi_loser_bonus_weight")}
              className="rounded-xl bg-surface-dim"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("multiLoserBonusHint")}
            </p>
          </div>

          {/* 세션 간 중복 당첨 방지 */}
          <div className="flex items-center gap-2">
            <input
              id="multi_cross_session_dedup"
              type="checkbox"
              {...register("multi_cross_session_dedup")}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <Label
              htmlFor="multi_cross_session_dedup"
              className="cursor-pointer"
            >
              {t("multiCrossSessionDedupLabel")}
            </Label>
          </div>
        </div>
      )}
    </div>
  );
}
