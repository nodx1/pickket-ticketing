"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { LayoutGrid, List, Ticket } from "lucide-react";
import { Button } from "@pickket/ui";
import EventCard from "@/components/event/EventCard";
import { searchEvents, type Event } from "@pickket/lib/api";
import {
  getCategoryBySlug,
  SORT_OPTIONS,
  SUB_CATEGORIES,
  CITIES,
  type CategorySlug,
} from "@pickket/lib";

/* -- Skeleton -- */

function SkeletonCard() {
  return (
    <div className="rounded-2xl shadow-lg overflow-hidden">
      <div className="aspect-[4/3] bg-white/5 animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 bg-white/5 rounded animate-pulse w-3/4" />
        <div className="space-y-2">
          <div className="h-4 bg-white/5 rounded animate-pulse w-1/2" />
          <div className="h-4 bg-white/5 rounded animate-pulse w-2/3" />
          <div className="h-4 bg-white/5 rounded animate-pulse w-1/3" />
        </div>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
      <div className="mb-8">
        <div className="h-8 bg-white/5 rounded-2xl animate-pulse w-1/4 mb-2" />
        <div className="h-4 bg-white/5 rounded animate-pulse w-1/6" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

/* -- Sort tabs with recommended -- */

/* -- Status filter options -- */

const STATUS_OPTION_VALUES = [
  { value: "bidding_open", key: "statusBiddingOpen" },
  { value: "draft", key: "statusDraft" },
  { value: "bidding_closed", key: "statusBiddingClosed" },
] as const;

/* -- Inner Page -- */

const PAGE_SIZE = 12;

function CategoryPageInner() {
  const t = useTranslations("category.slug");
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const slug = params.slug as string;
  const category = getCategoryBySlug(slug);

  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // 🔴 번역된 문자열이 아니라 **개수**를 담는다. 번역은 렌더 시점에 한다.
  //    (옛 방식은 fetch 시점 언어로 굳어 언어를 바꿔도 안 바뀌었다. 겸사겸사
  //     useCallback 이 t 를 가두지 않게 되어 React Compiler 도 통과한다.)
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const currentSort = searchParams.get("sort") || "recommended";
  const currentSubCategory = searchParams.get("sub_category") || "";
  const currentCity = searchParams.get("city") || "";
  const currentStatus = searchParams.get("status") || "";

  const subCategoryOptions = slug
    ? SUB_CATEGORIES[slug as CategorySlug] || []
    : [];

  /* -- Build search params from URL -- */

  const buildSearchParams = useCallback(
    (skip = 0) => {
      const p: Record<string, string | number> = {
        category: slug,
        skip,
        limit: PAGE_SIZE,
      };

      const sort = searchParams.get("sort");
      if (sort && sort !== "recommended") p.sort = sort;

      const subCategory = searchParams.get("sub_category");
      if (subCategory) p.sub_category = subCategory;

      const city = searchParams.get("city");
      if (city) p.city = city;

      const dateFrom = searchParams.get("date_from");
      if (dateFrom) p.date_from = dateFrom;

      const dateTo = searchParams.get("date_to");
      if (dateTo) p.date_to = dateTo;

      const priceMin = searchParams.get("price_min");
      if (priceMin) p.price_min = Number(priceMin);

      const priceMax = searchParams.get("price_max");
      if (priceMax) p.price_max = Number(priceMax);

      const status = searchParams.get("status");
      if (status) p.status = status;

      return p;
    },
    [slug, searchParams],
  );

  /* -- Fetch events -- */

  const loadEvents = useCallback(() => {
    setLoading(true);
    searchEvents(buildSearchParams(0))
      .then((res) => {
        const data = res.data;
        const list = Array.isArray(data) ? data : (data.events ?? []);
        setEvents(list);
        setHasMore(list.length >= PAGE_SIZE);
        setTotalCount(list.length ?? 0);
      })
      .catch(() => {
        setEvents([]);
        setTotalCount(0);
      })
      .finally(() => setLoading(false));
  }, [buildSearchParams]);

  useEffect(() => {
    if (!category) return;
    const timeoutId = window.setTimeout(() => {
      loadEvents();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [category, loadEvents]);

  /* -- Load more -- */

  const loadMore = () => {
    setLoadingMore(true);
    searchEvents(buildSearchParams(events.length))
      .then((res) => {
        const data = res.data;
        const list = Array.isArray(data) ? data : (data.events ?? []);
        setEvents((prev) => [...prev, ...list]);
        setHasMore(list.length >= PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  /* -- Update filter -- */

  const updateFilter = (key: string, value: string) => {
    const p = new URLSearchParams(searchParams.toString());
    if (!value || value === "recommended") {
      p.delete(key);
    } else {
      p.set(key, value);
    }
    router.push(`?${p.toString()}`);
  };

  /* -- Invalid category -- */

  if (!category) {
    return (
      <div className="text-center py-24 max-w-6xl mx-auto px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
        <Ticket className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("categoryNotFound")}</h1>
        <p className="text-muted-foreground mb-6">
          {t("categoryNotFoundDesc")}
        </p>
        <Button
          onClick={() => router.push("/events")}
          className="rounded-full bg-primary hover:bg-primary/90"
        >
          {t("goToEvents")}
        </Button>
      </div>
    );
  }

  /* -- Render -- */

  return (
    <div className="bg-background min-h-screen max-w-6xl mx-auto px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
      {/* Category Hero */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-3xl font-bold">{category.label}</h1>
          <span className="text-sm text-muted-foreground bg-white/5 px-3 py-1 rounded-full">
            {totalCount === null ? "" : t("totalEvents", { count: totalCount })}
          </span>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("categorySubtitle", { labelEn: category.labelEn ?? "" })}
        </p>
      </div>

      {/* Top pill filter bar */}
      <div className="space-y-3 mb-6">
        {/* Sort pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => updateFilter("sort", "recommended")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
              currentSort === "recommended"
                ? "bg-primary text-white shadow-sm"
                : "bg-white/5 hover:bg-white/10 text-foreground"
            }`}
          >
            {t("sortRecommended")}
          </button>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateFilter("sort", opt.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                currentSort === opt.value
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white/5 hover:bg-white/10 text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Sub-category pills (if available) */}
        {subCategoryOptions.length > 0 && (
          <div className="overflow-x-auto scrollbar-hide">
            <div className="flex gap-1.5 min-w-max">
              <button
                type="button"
                onClick={() => updateFilter("sub_category", "")}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap ${
                  !currentSubCategory
                    ? "bg-primary text-white shadow-sm"
                    : "bg-white/5 hover:bg-white/10 text-foreground"
                }`}
              >
                {t("filterAll")}
              </button>
              {subCategoryOptions.map((sub) => (
                <button
                  key={sub}
                  type="button"
                  onClick={() => updateFilter("sub_category", sub)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap ${
                    currentSubCategory === sub
                      ? "bg-primary text-white shadow-sm"
                      : "bg-white/5 hover:bg-white/10 text-foreground"
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* City + Status filter row */}
        <div className="flex flex-wrap gap-1.5">
          {/* City pills */}
          <button
            type="button"
            onClick={() => updateFilter("city", "")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
              !currentCity
                ? "bg-primary/10 text-primary/70"
                : "bg-white/5 hover:bg-white/10 text-foreground"
            }`}
          >
            {t("filterAllCities")}
          </button>
          {CITIES.slice(0, 7).map((city) => (
            <button
              key={city}
              type="button"
              onClick={() => updateFilter("city", city)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                currentCity === city
                  ? "bg-primary/10 text-primary/70"
                  : "bg-white/5 hover:bg-white/10 text-foreground"
              }`}
            >
              {city}
            </button>
          ))}

          <span className="w-px h-6 bg-white/8 mx-1 self-center" />

          {/* Status pills */}
          {STATUS_OPTION_VALUES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() =>
                updateFilter(
                  "status",
                  currentStatus === opt.value ? "" : opt.value,
                )
              }
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                currentStatus === opt.value
                  ? "bg-primary/10 text-primary/70"
                  : "bg-white/5 hover:bg-white/10 text-foreground"
              }`}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>
      </div>

      {/* View toggle */}
      <div className="flex items-center justify-end gap-1 mb-4">
        <div className="flex items-center gap-1 bg-white/5 rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`p-1.5 rounded-full transition-all duration-200 ${
              viewMode === "grid"
                ? "bg-card shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-label={t("ariaGridView")}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={`p-1.5 rounded-full transition-all duration-200 ${
              viewMode === "list"
                ? "bg-card shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-label={t("ariaListView")}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Events grid */}
      {loading ? (
        <div
          className={
            viewMode === "grid"
              ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6"
              : "grid grid-cols-1 gap-4"
          }
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-24">
          <Ticket className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">
            {t("emptyEvents")}
          </p>
          <p className="text-sm text-muted-foreground/60 mt-1">
            {t("emptyEventsDesc")}
          </p>
        </div>
      ) : (
        <>
          <div
            className={
              viewMode === "grid"
                ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6"
                : "grid grid-cols-1 gap-4"
            }
          >
            {events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center mt-8">
              <Button
                variant="outline"
                onClick={loadMore}
                disabled={loadingMore}
                className="min-w-[160px] rounded-full"
              >
                {loadingMore ? t("loadingMore") : t("loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -- Exported page with Suspense -- */

export default function CategoryPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CategoryPageInner />
    </Suspense>
  );
}
