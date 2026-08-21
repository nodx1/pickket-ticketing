"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { LayoutGrid, List } from "lucide-react";
import { SORT_OPTIONS } from "@pickket/lib";
import type { EventSearchResponse, SearchParams } from "@pickket/lib/api";
import { useEventSearch } from "@/hooks/useEventSearch";
import EventFilters from "./EventFilters";
import EventGrid from "./EventGrid";
import EventListView from "./EventListView";
import InfiniteScrollTrigger from "./InfiniteScrollTrigger";
import EmptyState from "./EmptyState";

interface EventsClientProps {
  initialData?: EventSearchResponse;
}

export default function EventsClient({ initialData }: EventsClientProps) {
  const t = useTranslations("event.eventsClient");
  const searchParams = useSearchParams();
  const router = useRouter();
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  /* ── Build filters from URL ──────────────────────────────────────── */

  const filters: SearchParams = {};
  const q = searchParams.get("q");
  if (q) filters.q = q;

  const category = searchParams.get("category");
  if (category) filters.category = category;

  const sort = searchParams.get("sort");
  filters.sort = sort || "newest";

  const subCategory = searchParams.get("sub_category");
  if (subCategory) filters.sub_category = subCategory;

  const city = searchParams.get("city");
  if (city) filters.city = city;

  const dateFrom = searchParams.get("date_from");
  if (dateFrom) filters.date_from = dateFrom;

  const dateTo = searchParams.get("date_to");
  if (dateTo) filters.date_to = dateTo;

  const priceMin = searchParams.get("price_min");
  if (priceMin) filters.price_min = Number(priceMin);

  const priceMax = searchParams.get("price_max");
  if (priceMax) filters.price_max = Number(priceMax);

  const status = searchParams.get("status");
  if (status) filters.status = status;

  /* ── Query ───────────────────────────────────────────────────────── */

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useEventSearch(filters, initialData);

  const events = data?.pages.flatMap((p) => p.events) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  /* ── Filter helpers ──────────────────────────────────────────────── */

  const updateParam = useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(searchParams.toString());
      if (value) p.set(key, value);
      else p.delete(key);
      router.replace(`?${p.toString()}`);
    },
    [searchParams, router],
  );

  const updatePriceRange = useCallback(
    (min: number | undefined, max: number | undefined) => {
      const p = new URLSearchParams(searchParams.toString());
      if (min !== undefined) p.set("price_min", String(min));
      else p.delete("price_min");
      if (max !== undefined) p.set("price_max", String(max));
      else p.delete("price_max");
      router.replace(`?${p.toString()}`);
    },
    [searchParams, router],
  );

  const clearFilter = useCallback(
    (key: string) => {
      const p = new URLSearchParams(searchParams.toString());
      p.delete(key);
      if (key === "price") {
        p.delete("price_min");
        p.delete("price_max");
      }
      router.replace(`?${p.toString()}`);
    },
    [searchParams, router],
  );

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <div className="bg-background min-h-screen max-w-7xl mx-auto px-4 sm:px-8 pt-24">
      {/* 검색은 헤더에서 처리 — 이벤트 목록 검색창 제거 */}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">
          {q ? t("searchResult", { q: q ?? "" }) : t("events")}
        </h1>
      </div>

      {/* Filters */}
      <EventFilters
        currentCategory={category || ""}
        currentCity={city || ""}
        currentStatus={status || ""}
        currentSort={sort || "newest"}
        currentPriceMin={priceMin || ""}
        currentPriceMax={priceMax || ""}
        onUpdateParam={updateParam}
        onUpdatePriceRange={updatePriceRange}
        onClearFilter={clearFilter}
      />

      {/* Sort + View toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
        <p className="text-sm text-muted-foreground">{t("totalEvents", { total: total ?? 0 })}</p>
        <div className="flex flex-wrap items-center gap-2">
          {/* 정렬 */}
          <div className="flex flex-wrap items-center gap-1">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => updateParam("sort", opt.value)}
                className={`px-3 py-2 rounded-full text-sm font-medium transition-all duration-200 min-h-[36px] ${
                  (sort || "newest") === opt.value
                    ? "bg-primary text-white shadow-md"
                    : "bg-card/90 backdrop-blur-sm text-foreground shadow-lg hover:shadow-xl hover:-translate-y-0.5"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-full bg-card/90 backdrop-blur-sm shadow-lg p-1">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`p-2 rounded-full transition-all duration-200 min-w-[32px] min-h-[32px] flex items-center justify-center ${
                viewMode === "grid"
                  ? "bg-primary text-white shadow-md"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label={t("gridView")}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`p-2 rounded-full transition-all duration-200 min-w-[32px] min-h-[32px] flex items-center justify-center ${
                viewMode === "list"
                  ? "bg-primary text-white shadow-md"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label={t("listView")}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Events content */}
      <section className="mb-16" aria-labelledby="events-results-heading">
        {/*
          🔴 화면에는 안 보이지만 **문서 구조상 반드시 있어야 하는** 제목이다.
          이 페이지는 h1(제목) 다음에 곧바로 카드의 h3 가 나와 h2 를 건너뛰었다
          (a11y E2E: "이벤트 목록: h1 → h3 (레벨 건너뛰기)").
          스크린리더 사용자는 heading 을 목차처럼 훑는데, 단계가 비면 어디로 들어왔는지
          알 수 없다. 카드의 h3 를 h2 로 바꾸지 않은 것은 EventCard 가 다른 화면에서도
          쓰이기 때문이다 — 여기서 한 단계를 채우는 쪽이 부작용이 없다.
        */}
        <h2 id="events-results-heading" className="sr-only">
          {t("events")}
        </h2>
        {!isLoading && events.length === 0 ? (
          <EmptyState hasQuery={!!q} />
        ) : viewMode === "grid" ? (
          <EventGrid events={events} isLoading={isLoading} />
        ) : (
          <EventListView events={events} isLoading={isLoading} />
        )}
      </section>

      {/* Infinite scroll */}
      {hasNextPage && (
        <InfiniteScrollTrigger
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
        />
      )}
    </div>
  );
}
