"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  X,
  MapPin,
  DollarSign,
  Activity,
  SlidersHorizontal,
} from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@pickket/ui";
import { CATEGORIES, CITIES } from "@pickket/lib";

/* ── Constants ──────────────────────────────────────────────────────── */

export const STATUS_OPTIONS = [
  { value: "active", label: "진행중" },
  { value: "completed", label: "종료" },
  { value: "bidding_open", label: "응모중" },
  { value: "draft", label: "오픈예정" },
  { value: "bidding_closed", label: "응모마감" },
];

export const PRICE_RANGES = [
  { value: "0-50000", label: "~5만원", min: 0, max: 50000 },
  { value: "50000-100000", label: "5~10만원", min: 50000, max: 100000 },
  { value: "100000-200000", label: "10~20만원", min: 100000, max: 200000 },
  { value: "200000-", label: "20만원~", min: 200000, max: undefined },
];

/* ── Filter Dropdown (desktop) ─────────────────────────────────────── */

function FilterDropdown({
  label,
  icon,
  isActive,
  children,
  className,
}: {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
          isActive
            ? "bg-primary text-white shadow-md"
            : "bg-card/90 backdrop-blur-sm text-foreground shadow-lg hover:shadow-xl hover:-translate-y-0.5"
        }`}
      >
        {icon}
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 z-50 mt-2 min-w-[200px] rounded-2xl shadow-xl bg-card/95 backdrop-blur-xl p-3 border-0"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Types ──────────────────────────────────────────────────────────── */

interface EventFiltersProps {
  currentCategory: string;
  currentCity: string;
  currentStatus: string;
  currentSort: string;
  currentPriceMin: string;
  currentPriceMax: string;
  onUpdateParam: (key: string, value: string) => void;
  onUpdatePriceRange: (
    min: number | undefined,
    max: number | undefined,
  ) => void;
  onClearFilter: (key: string) => void;
}

/* ── Option Button (shared) ────────────────────────────────────────── */

function OptionButton({
  isSelected,
  onClick,
  children,
}: {
  isSelected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${
        isSelected
          ? "bg-primary text-white"
          : "hover:bg-white/5 text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/* ── Mobile Filter Sheet ───────────────────────────────────────────── */

function MobileFilterSheet({
  currentCity,
  currentStatus,
  currentSort: _currentSort,
  currentPriceMin,
  onUpdateParam,
  onUpdatePriceRange,
}: Pick<
  EventFiltersProps,
  | "currentCity"
  | "currentStatus"
  | "currentSort"
  | "currentPriceMin"
  | "onUpdateParam"
  | "onUpdatePriceRange"
>) {
  const t = useTranslations("event.filters");
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium bg-card/90 backdrop-blur-sm text-foreground shadow-lg"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t("filter")}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl bg-card border-0 max-h-[70vh] overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle className="text-foreground">{t("filter")}</SheetTitle>
        </SheetHeader>
        <div className="space-y-6 p-4">
          {/* City */}
          <div>
            <h4 className="text-sm font-bold text-foreground mb-2">{t("city")}</h4>
            <div className="flex flex-wrap gap-2">
              {CITIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    onUpdateParam("city", currentCity === c ? "" : c)
                  }
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    currentCity === c
                      ? "bg-primary text-white"
                      : "bg-white/5 text-foreground"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Price */}
          <div>
            <h4 className="text-sm font-bold text-foreground mb-2">{t("price")}</h4>
            <div className="flex flex-wrap gap-2">
              {PRICE_RANGES.map((range) => (
                <button
                  key={range.value}
                  type="button"
                  onClick={() => onUpdatePriceRange(range.min, range.max)}
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    String(range.min) === currentPriceMin
                      ? "bg-primary text-white"
                      : "bg-white/5 text-foreground"
                  }`}
                >
                  {t(`priceRange.${range.value.replace(/-/g, "_")}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Status */}
          <div>
            <h4 className="text-sm font-bold text-foreground mb-2">{t("status")}</h4>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    onUpdateParam(
                      "status",
                      currentStatus === opt.value ? "" : opt.value,
                    )
                  }
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    currentStatus === opt.value
                      ? "bg-primary text-white"
                      : "bg-white/5 text-foreground"
                  }`}
                >
                  {t(`statusOption.${opt.value}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── Main Component ────────────────────────────────────────────────── */

export default function EventFilters({
  currentCategory,
  currentCity,
  currentStatus,
  currentSort,
  currentPriceMin,
  currentPriceMax,
  onUpdateParam,
  onUpdatePriceRange,
  onClearFilter,
}: EventFiltersProps) {
  const t = useTranslations("event.filters");

  const hasActiveFilters =
    currentCategory ||
    currentCity ||
    currentStatus ||
    currentPriceMin ||
    currentPriceMax;

  const matchedPriceRange = currentPriceMin || currentPriceMax
    ? PRICE_RANGES.find(
        (r) =>
          String(r.min) === currentPriceMin &&
          (r.max === undefined
            ? !currentPriceMax
            : String(r.max) === currentPriceMax),
      )
    : undefined;

  const activePriceLabel =
    currentPriceMin || currentPriceMax
      ? matchedPriceRange
        ? t(`priceRange.${matchedPriceRange.value.replace(/-/g, "_")}`)
        : `${currentPriceMin ? `${Number(currentPriceMin) / 10000}${t("manUnit")}` : ""}~${currentPriceMax ? `${Number(currentPriceMax) / 10000}${t("manUnit")}` : ""}`
      : null;

  return (
    <div className="space-y-3 mb-8">
      <div className="flex flex-wrap items-center gap-2">
        {/* Category pills */}
        {CATEGORIES.map((cat) => (
          <button
            key={cat.slug}
            type="button"
            onClick={() =>
              onUpdateParam(
                "category",
                currentCategory === cat.slug ? "" : cat.slug,
              )
            }
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              currentCategory === cat.slug
                ? "bg-primary text-white shadow-md"
                : "bg-card/90 backdrop-blur-sm text-foreground shadow-lg hover:shadow-xl hover:-translate-y-0.5"
            }`}
          >
            {cat.label}
          </button>
        ))}

        {/* Divider */}
        <div className="hidden md:block w-px h-6 border-white/8 bg-white/8 mx-1" />

        {/* Desktop filter dropdowns */}
        <FilterDropdown
          label={currentCity || t("city")}
          icon={<MapPin className="h-3.5 w-3.5" />}
          isActive={!!currentCity}
          className="hidden md:block"
        >
          <div className="space-y-0.5">
            {CITIES.map((c) => (
              <OptionButton
                key={c}
                isSelected={currentCity === c}
                onClick={() =>
                  onUpdateParam("city", currentCity === c ? "" : c)
                }
              >
                {c}
              </OptionButton>
            ))}
          </div>
        </FilterDropdown>

        <FilterDropdown
          label={activePriceLabel || t("price")}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          isActive={!!(currentPriceMin || currentPriceMax)}
          className="hidden md:block"
        >
          <div className="space-y-0.5">
            {PRICE_RANGES.map((range) => (
              <OptionButton
                key={range.value}
                isSelected={String(range.min) === currentPriceMin}
                onClick={() => onUpdatePriceRange(range.min, range.max)}
              >
                {t(`priceRange.${range.value.replace(/-/g, "_")}`)}
              </OptionButton>
            ))}
          </div>
        </FilterDropdown>

        <FilterDropdown
          label={
            currentStatus
              ? t(`statusOption.${currentStatus}`)
              : t("status")
          }
          icon={<Activity className="h-3.5 w-3.5" />}
          isActive={!!currentStatus}
          className="hidden md:block"
        >
          <div className="space-y-0.5">
            {STATUS_OPTIONS.map((opt) => (
              <OptionButton
                key={opt.value}
                isSelected={currentStatus === opt.value}
                onClick={() =>
                  onUpdateParam(
                    "status",
                    currentStatus === opt.value ? "" : opt.value,
                  )
                }
              >
                {t(`statusOption.${opt.value}`)}
              </OptionButton>
            ))}
          </div>
        </FilterDropdown>

        {/* Mobile filter button */}
        <div className="md:hidden">
          <MobileFilterSheet
            currentCity={currentCity}
            currentStatus={currentStatus}
            currentSort={currentSort}
            currentPriceMin={currentPriceMin}
            onUpdateParam={onUpdateParam}
            onUpdatePriceRange={onUpdatePriceRange}
          />
        </div>
      </div>

      {/* Active filter badges */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {currentCategory && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary/70 text-xs font-medium">
              {CATEGORIES.find((c) => c.slug === currentCategory)?.label}
              <button
                type="button"
                onClick={() => onClearFilter("category")}
                className="hover:text-primary/70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {currentCity && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary/70 text-xs font-medium">
              {currentCity}
              <button
                type="button"
                onClick={() => onClearFilter("city")}
                className="hover:text-primary/70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {activePriceLabel && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary/70 text-xs font-medium">
              {activePriceLabel}
              <button
                type="button"
                onClick={() => onClearFilter("price")}
                className="hover:text-primary/70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {currentStatus && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary/70 text-xs font-medium">
              {t(`statusOption.${currentStatus}`)}
              <button
                type="button"
                onClick={() => onClearFilter("status")}
                className="hover:text-primary/70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
