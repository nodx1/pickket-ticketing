"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { CITIES, SUB_CATEGORIES, type CategorySlug } from "@pickket/lib";

interface FilterSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function FilterSection({
  title,
  defaultOpen = true,
  children,
}: FilterSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-3 text-sm font-medium hover:text-primary transition-colors"
      >
        {title}
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {isOpen && <div className="pb-3">{children}</div>}
    </div>
  );
}

interface EventFilterProps {
  category?: CategorySlug;
}

export default function EventFilter({ category }: EventFilterProps) {
  const t = useTranslations("event.filter");
  const router = useRouter();
  const searchParams = useSearchParams();

  // Local filter state derived from URL
  const [subCategories, setSubCategories] = useState<string[]>(
    searchParams.get("sub_category")?.split(",").filter(Boolean) || [],
  );
  const [cities, setCities] = useState<string[]>(
    searchParams.get("city")?.split(",").filter(Boolean) || [],
  );
  const [dateFrom, setDateFrom] = useState(searchParams.get("date_from") || "");
  const [dateTo, setDateTo] = useState(searchParams.get("date_to") || "");
  const [priceMin, setPriceMin] = useState(searchParams.get("price_min") || "");
  const [priceMax, setPriceMax] = useState(searchParams.get("price_max") || "");
  const [statuses, setStatuses] = useState<string[]>(
    searchParams.get("status")?.split(",").filter(Boolean) || [],
  );

  const subCategoryOptions = category ? SUB_CATEGORIES[category] : [];

  const toggleArrayValue = (arr: string[], value: string): string[] => {
    return arr.includes(value)
      ? arr.filter((v) => v !== value)
      : [...arr, value];
  };

  const applyFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());

    if (subCategories.length > 0) {
      params.set("sub_category", subCategories.join(","));
    } else {
      params.delete("sub_category");
    }

    if (cities.length > 0) {
      params.set("city", cities.join(","));
    } else {
      params.delete("city");
    }

    if (dateFrom) params.set("date_from", dateFrom);
    else params.delete("date_from");

    if (dateTo) params.set("date_to", dateTo);
    else params.delete("date_to");

    if (priceMin) params.set("price_min", priceMin);
    else params.delete("price_min");

    if (priceMax) params.set("price_max", priceMax);
    else params.delete("price_max");

    if (statuses.length > 0) {
      params.set("status", statuses.join(","));
    } else {
      params.delete("status");
    }

    router.push(`?${params.toString()}`);
  }, [
    router,
    searchParams,
    subCategories,
    cities,
    dateFrom,
    dateTo,
    priceMin,
    priceMax,
    statuses,
  ]);

  const resetFilters = () => {
    setSubCategories([]);
    setCities([]);
    setDateFrom("");
    setDateTo("");
    setPriceMin("");
    setPriceMax("");
    setStatuses([]);

    const params = new URLSearchParams();
    const q = searchParams.get("q");
    const cat = searchParams.get("category");
    if (q) params.set("q", q);
    if (cat) params.set("category", cat);
    router.push(`?${params.toString()}`);
  };

  return (
    <div className="space-y-0">
      {/* Sub-categories (only if category is set) */}
      {subCategoryOptions.length > 0 && (
        <FilterSection title={t("subCategory")}>
          <div className="space-y-1">
            {subCategoryOptions.map((sub) => (
              <label
                key={sub}
                className="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={subCategories.includes(sub)}
                  onChange={() =>
                    setSubCategories(toggleArrayValue(subCategories, sub))
                  }
                  className="rounded border-border"
                />
                {sub}
              </label>
            ))}
          </div>
        </FilterSection>
      )}

      {/* City */}
      <FilterSection title={t("city")}>
        <div className="grid grid-cols-2 gap-1">
          {CITIES.map((city) => (
            <label
              key={city}
              className="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={cities.includes(city)}
                onChange={() => setCities(toggleArrayValue(cities, city))}
                className="rounded border-border"
              />
              {city}
            </label>
          ))}
        </div>
      </FilterSection>

      {/* Date range */}
      <FilterSection title={t("date")}>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-muted-foreground">{t("dateFrom")}</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t("dateTo")}</label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>
      </FilterSection>

      {/* Price range */}
      <FilterSection title={t("price")}>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            placeholder={t("priceMin")}
            value={priceMin}
            onChange={(e) => setPriceMin(e.target.value)}
            className="h-8 text-sm"
          />
          <span className="text-muted-foreground text-sm">~</span>
          <Input
            type="number"
            placeholder={t("priceMax")}
            value={priceMax}
            onChange={(e) => setPriceMax(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      </FilterSection>

      {/* Status */}
      <FilterSection title={t("status")}>
        <div className="space-y-1">
          {[
            { value: "bidding_open", label: t("statusBiddingOpen") },
            { value: "draft", label: t("statusDraft") },
            { value: "bidding_closed", label: t("statusBiddingClosed") },
          ].map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={statuses.includes(opt.value)}
                onChange={() =>
                  setStatuses(toggleArrayValue(statuses, opt.value))
                }
                className="rounded border-border"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </FilterSection>

      {/* Action buttons */}
      <div className="flex gap-2 pt-4">
        <Button onClick={applyFilters} size="sm" className="flex-1">
          {t("applyFilter")}
        </Button>
        <Button
          onClick={resetFilters}
          variant="outline"
          size="sm"
          className="gap-1"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("reset")}
        </Button>
      </div>
    </div>
  );
}
