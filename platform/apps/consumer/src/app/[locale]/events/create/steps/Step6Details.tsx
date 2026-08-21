"use client";

import { useFormContext } from "react-hook-form";
import {
  FileText,
  Ticket,
  Smartphone,
  Calendar,
  Users,
  MessageSquare,
} from "lucide-react";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Textarea } from "@pickket/ui";
import { getOrganizerLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";
import type { EventFormValues } from "../schema";

export default function Step6Details() {
  const t = useTranslations("event.createStep6");
  const {
    register,
    watch,
    setValue,
  } = useFormContext<EventFormValues>();

  const category = watch("category");
  const seatType = watch("seat_type");
  const labels = getOrganizerLabels(category || "concert");

  const AGE_RATINGS = [
    t("ageAll"),
    t("age12"),
    t("age15"),
    t("age19"),
  ];

  return (
    <div className="space-y-6">
      {/* 관람 등급 & 좌석 */}
      <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          {t("detailsTitle", { eventLabel: labels.eventLabel ?? "" })}
        </h2>

        {/* 관람등급 */}
        <div>
          <Label className="flex items-center gap-1.5 mb-2">
            {labels.ageRatingLabel}
          </Label>
          <div className="flex flex-wrap gap-2">
            {AGE_RATINGS.map((rating) => (
              <button
                key={rating}
                type="button"
                onClick={() => setValue("age_rating", rating)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                  watch("age_rating") === rating
                    ? "bg-primary text-white shadow-md"
                    : "bg-surface-dim text-muted-foreground hover:bg-muted"
                }`}
              >
                {rating}
              </button>
            ))}
          </div>
        </div>

        {/* 좌석 판매형태 */}
        <div>
          <Label className="flex items-center gap-1.5 mb-2">{t("seatSaleType")}</Label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setValue("seat_type", "assigned")}
              className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all border ${
                seatType === "assigned"
                  ? "bg-primary/10 border-primary text-primary"
                  : "bg-surface-dim border-transparent text-muted-foreground"
              }`}
            >
              {t("assignedSeat")}
            </button>
            <button
              type="button"
              onClick={() => setValue("seat_type", "unassigned")}
              className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all border ${
                seatType === "unassigned"
                  ? "bg-primary/10 border-primary text-primary"
                  : "bg-surface-dim border-transparent text-muted-foreground"
              }`}
            >
              {t("unassignedSeat")}
            </button>
          </div>
        </div>

        {/* 좌석배치도 URL (지정석일 때만) */}
        {seatType === "assigned" && (
          <div>
            <Label htmlFor="seat_map_url" className="flex items-center gap-1.5 mb-1.5">
              {t("seatMapUrl")}
            </Label>
            <Input
              id="seat_map_url"
              {...register("seat_map_url")}
              placeholder="https://example.com/seatmap.png"
              className="rounded-xl bg-surface-dim"
            />
          </div>
        )}

        {/* 좌석할당비중 */}
        <div>
          <Label htmlFor="allocation_ratio" className="flex items-center gap-1.5 mb-1.5">
            {t("allocationRatio")}
          </Label>
          <Input
            id="allocation_ratio"
            type="number"
            {...register("allocation_ratio")}
            placeholder="100"
            min={0}
            max={100}
            className="rounded-xl bg-surface-dim"
          />
        </div>

        {/* 종료일 */}
        <div>
          <Label htmlFor="event_date_end" className="flex items-center gap-1.5 mb-1.5">
            <Calendar className="h-3.5 w-3.5" /> {t("eventEndDate", { eventLabel: labels.eventLabel ?? "" })}
          </Label>
          <Input
            id="event_date_end"
            type="datetime-local"
            {...register("event_date_end")}
            className="rounded-xl bg-surface-dim"
          />
          <p className="text-xs text-muted-foreground mt-1">{t("eventEndDateHint", { eventLabel: labels.eventLabel ?? "" })}</p>
        </div>
      </div>

      {/* 티켓 수령 & 모바일 */}
      <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Ticket className="h-5 w-5 text-primary" />
          {t("ticketSettings")}
        </h2>

        {/* 티켓수령방법 */}
        <div>
          <Label className="flex items-center gap-1.5 mb-2">{t("deliveryMethod")}</Label>
          <div className="flex gap-2 flex-wrap">
            {[
              { value: "mobile", label: t("deliveryMobile"), icon: Smartphone },
              { value: "onsite", label: t("deliveryOnsite") },
              { value: "delivery", label: t("deliveryShipping") },
            ].map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setValue("delivery_method", value as "mobile" | "onsite" | "delivery")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                  watch("delivery_method") === value
                    ? "bg-primary text-white shadow-md"
                    : "bg-surface-dim text-muted-foreground hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 모바일티켓 토글 */}
        <div className="flex items-center gap-3">
          <input
            id="mobile_ticket_enabled"
            type="checkbox"
            {...register("mobile_ticket_enabled")}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <Label htmlFor="mobile_ticket_enabled" className="cursor-pointer">
            <Smartphone className="h-3.5 w-3.5 inline mr-1" />
            {t("mobileTicketEnabled")}
          </Label>
        </div>

        {/* 티켓표시사항 */}
        <div>
          <Label htmlFor="ticket_display_info" className="flex items-center gap-1.5 mb-1.5">
            {t("ticketDisplayInfo")}
          </Label>
          <Textarea
            id="ticket_display_info"
            {...register("ticket_display_info")}
            placeholder={t("ticketDisplayInfoPlaceholder")}
            className="rounded-xl bg-surface-dim min-h-[80px]"
          />
        </div>

        {/* 판매오픈희망일 */}
        <div>
          <Label htmlFor="desired_open_date" className="flex items-center gap-1.5 mb-1.5">
            <Calendar className="h-3.5 w-3.5" /> {t("desiredOpenDate")}
          </Label>
          <Input
            id="desired_open_date"
            type="datetime-local"
            {...register("desired_open_date")}
            className="rounded-xl bg-surface-dim"
          />
        </div>
      </div>

      {/* 공지사항 & 상세설명 & 게시판 */}
      <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-lg p-5 lg:p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          {t("additionalInfo")}
        </h2>

        {/* 공지사항 */}
        <div>
          <Label htmlFor="notice" className="flex items-center gap-1.5 mb-1.5">
            {t("notice")}
          </Label>
          <Textarea
            id="notice"
            {...register("notice")}
            placeholder={t("noticePlaceholder")}
            className="rounded-xl bg-surface-dim min-h-[100px]"
          />
        </div>

        {/* 상세설명 이미지 URLs */}
        <div>
          <Label htmlFor="description_images" className="flex items-center gap-1.5 mb-1.5">
            {t("descriptionImagesUrl", { descriptionLabel: labels.descriptionLabel ?? "" })}
          </Label>
          <Textarea
            id="description_images"
            {...register("description_images")}
            placeholder={t("descriptionImagesPlaceholder")}
            className="rounded-xl bg-surface-dim min-h-[80px]"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("descriptionImagesHint")}
          </p>
        </div>

        {/* 출연자/참가자 토글 */}
        <div className="flex items-center gap-3">
          <input
            id="participant_enabled"
            type="checkbox"
            {...register("participant_enabled")}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <Label htmlFor="participant_enabled" className="cursor-pointer">
            <Users className="h-3.5 w-3.5 inline mr-1" />
            {t("participantManageEnabled", { participantLabel: labels.participantLabel ?? "" })}
          </Label>
          <span className="text-xs text-muted-foreground">
            {t("participantManageHint", { participantLabel: labels.participantLabel ?? "" })}
          </span>
        </div>

        {/* 게시판 노출 */}
        <div>
          <Label className="flex items-center gap-1.5 mb-2">{t("boardExposure")}</Label>
          <div className="flex gap-2 flex-wrap">
            {[
              { value: "review", label: labels.reviewLabel },
              { value: "expectation", label: labels.expectationLabel },
              { value: "qna", label: "Q&A" },
            ].map(({ value, label }) => {
              const currentTypes = watch("board_types") || "";
              const selected = currentTypes.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    const types = currentTypes
                      ? currentTypes.split(",").filter(Boolean)
                      : [];
                    if (selected) {
                      setValue(
                        "board_types",
                        types.filter((t) => t !== value).join(",")
                      );
                    } else {
                      setValue("board_types", [...types, value].join(","));
                    }
                  }}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    selected
                      ? "bg-primary text-white shadow-md"
                      : "bg-surface-dim text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
