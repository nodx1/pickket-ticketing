"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Search, X, Clock, TrendingUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { routing } from "@/i18n/routing";

const RECENT_SEARCHES_KEY = "pickket_recent_searches";

function getRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query: string) {
  if (typeof window === "undefined" || !query.trim()) return;
  try {
    const recent = getRecentSearches();
    const filtered = recent.filter((s) => s !== query);
    const updated = [query, ...filtered].slice(0, 5);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch {}
}

function clearRecentSearches() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RECENT_SEARCHES_KEY);
  } catch {}
}

function buildSearchPath(locale: string, query: string): string {
  const basePath =
    locale === routing.defaultLocale ? "/browse" : `/${locale}/browse`;
  return `${basePath}?q=${encodeURIComponent(query.trim())}`;
}

export default function SearchBar({ overlay: _overlay = false }: { overlay?: boolean }) {
  const [query, setQuery] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("nav");
  const popularRaw = t.raw("popular_searches");
  const popularSearches: string[] = Array.isArray(popularRaw) ? popularRaw : [];

  useEffect(() => {
    setRecentSearches(getRecentSearches());
  }, [isFocused]);

  const showDropdown = isFocused && !query.trim();

  const focusSearch = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsExpanded(true);
      return;
    }
    desktopInputRef.current?.focus();
  }, []);

  const closeMobileSearch = useCallback(() => {
    setIsExpanded(false);
    setQuery("");
    setIsFocused(false);
  }, []);

  const handleSearch = useCallback(
    (term: string) => {
      if (!term.trim()) return;
      saveRecentSearch(term.trim());
      router.push(buildSearchPath(locale, term));
      setIsExpanded(false);
      setIsFocused(false);
      setQuery("");
    },
    [router, locale],
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    handleSearch(query);
  };

  const handleClearRecent = () => {
    clearRecentSearches();
    setRecentSearches([]);
  };

  // 드롭다운 바깥 클릭 시 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsFocused(false);
      }
    };
    if (showDropdown) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDropdown]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
      }
      if (event.key === "Escape") {
        setIsFocused(false);
        closeMobileSearch();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeMobileSearch, focusSearch]);

  useEffect(() => {
    if (!isExpanded) return;
    const frame = window.requestAnimationFrame(() => {
      mobileInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isExpanded]);

  /* ── 인기/최근 검색어 드롭다운 ── */
  const searchSuggestions = (
    <div className="space-y-4">
      {/* 최근 검색어 */}
      {recentSearches.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              최근 검색어
            </span>
            <button
              type="button"
              onClick={handleClearRecent}
              className="flex items-center gap-1 text-2xs text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              전체 삭제
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => handleSearch(term)}
                className="px-3 py-1.5 rounded-full bg-muted text-sm text-foreground hover:bg-muted/80 transition-colors"
              >
                {term}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 인기 검색어 */}
      <div>
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2">
          <TrendingUp className="h-3.5 w-3.5" />
          인기 검색어
        </span>
        <div className="flex flex-wrap gap-2">
          {popularSearches.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => handleSearch(term)}
              className="px-3 py-1.5 rounded-full bg-primary/10 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              {term}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* 데스크톱 */}
      <div className="hidden md:block relative" ref={dropdownRef}>
        <form onSubmit={handleSubmit}>
          <div className="relative flex h-9 w-72 items-center rounded-full px-4 ring-1 ring-inset transition bg-white/10 backdrop-blur-sm ring-white/20 focus-within:ring-white/40">
            <Search className="h-4 w-4 shrink-0 text-white/60 mr-2" />
            <input
              ref={desktopInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setIsFocused(true)}
              placeholder={t("search")}
              aria-label={t("search")}
              className="h-full flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/50"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-muted-foreground/60 transition hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </form>

        {/* 데스크톱 드롭다운 */}
        {showDropdown && (
          <div className="absolute top-full right-0 mt-2 w-80 rounded-2xl border border-border bg-card shadow-xl p-4 z-50">
            {searchSuggestions}
          </div>
        )}
      </div>

      {/* 모바일 */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          aria-label={t("search")}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted text-muted-foreground transition hover:text-foreground"
        >
          <Search className="h-4 w-4" />
        </button>

        {isExpanded && (
          <div className="fixed inset-0 z-[70] bg-background/70 px-4 pt-4 backdrop-blur-sm">
            <div className="mx-auto max-w-[1100px]">
              <div className="rounded-[28px] border border-input bg-card/95 p-2 shadow-[0_16px_60px_rgba(0,0,0,0.18)]">
                <form onSubmit={handleSubmit}>
                  <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <input
                      ref={mobileInputRef}
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("search")}
                      aria-label={t("search")}
                      className="h-11 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    {query ? (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="text-muted-foreground transition hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={closeMobileSearch}
                      className="rounded-full bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      닫기
                    </button>
                  </div>
                </form>

                {/* 모바일 검색어 추천 */}
                {!query.trim() && (
                  <div className="p-4">{searchSuggestions}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
