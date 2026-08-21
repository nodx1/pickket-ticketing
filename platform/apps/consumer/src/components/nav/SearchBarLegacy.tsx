"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Search, X, Clock, TrendingUp } from "lucide-react";
import { Input } from "@pickket/ui";
import { parseSmartQuery, parsedQueryToTags } from "@/lib/smartSearch";

const POPULAR_SEARCHES = ["콘서트", "뮤지컬", "스포츠", "축제", "전시"];

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
  } catch {
    // Ignore localStorage errors
  }
}

interface SearchBarProps {
  compact?: boolean;
  hero?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export default function SearchBar({
  compact = false,
  hero = false,
  className = "",
  autoFocus = false,
}: SearchBarProps) {
  const t = useTranslations("nav.searchBar");
  const router = useRouter();
  const [inputValue, setInputValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    getRecentSearches(),
  );
  const [tags, setTags] = useState<{ key: string; label: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse tags on input change (debounced)
  const updateTags = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        const parsed = parseSmartQuery(value);
        setTags(parsedQueryToTags(parsed));
      } else {
        setTags([]);
      }
    }, 300);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    updateTags(value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    saveRecentSearch(inputValue.trim());
    setRecentSearches(getRecentSearches());
    const parsed = parseSmartQuery(inputValue);
    const params = new URLSearchParams();
    if (parsed.q) params.set("q", parsed.q);
    if (parsed.category) params.set("category", parsed.category);
    if (parsed.city) params.set("city", parsed.city);
    if (parsed.date_from) params.set("date_from", parsed.date_from);
    if (parsed.date_to) params.set("date_to", parsed.date_to);
    if (parsed.price_min !== undefined)
      params.set("price_min", String(parsed.price_min));
    if (parsed.price_max !== undefined)
      params.set("price_max", String(parsed.price_max));
    router.push(`/browse?${params.toString()}`);
    setIsFocused(false);
  };

  const handleSuggestionClick = (query: string) => {
    setInputValue(query);
    saveRecentSearch(query);
    setRecentSearches(getRecentSearches());
    const parsed = parseSmartQuery(query);
    const params = new URLSearchParams();
    if (parsed.q) params.set("q", parsed.q);
    if (parsed.category) params.set("category", parsed.category);
    if (parsed.city) params.set("city", parsed.city);
    if (parsed.date_from) params.set("date_from", parsed.date_from);
    if (parsed.date_to) params.set("date_to", parsed.date_to);
    if (parsed.price_min !== undefined)
      params.set("price_min", String(parsed.price_min));
    if (parsed.price_max !== undefined)
      params.set("price_max", String(parsed.price_max));
    router.push(`/browse?${params.toString()}`);
    setIsFocused(false);
  };

  const removeTag = (key: string) => {
    const parsed = parseSmartQuery(inputValue);
    if (key === "category") delete parsed.category;
    if (key === "city") delete parsed.city;
    if (key === "date") {
      delete parsed.date_from;
      delete parsed.date_to;
    }
    if (key === "price") {
      delete parsed.price_min;
      delete parsed.price_max;
    }
    if (key === "q") delete parsed.q;
    // Rebuild input from remaining parsed query parts
    const parts: string[] = [];
    if (parsed.q) parts.push(parsed.q);
    setInputValue(parts.join(" "));
    setTags(parsedQueryToTags(parsed));
  };

  const clearInput = () => {
    setInputValue("");
    setTags([]);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsFocused(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const showDropdown = isFocused && !inputValue.trim();

  // ── Hero mode ──────────────────────────────────────────────────────
  if (hero) {
    return (
      <div
        ref={containerRef}
        className={`relative max-w-[640px] mx-auto ${className}`}
      >
        <form onSubmit={handleSubmit}>
          <div
            className={`relative flex items-center h-[56px] rounded-full border bg-card shadow-sm transition-all duration-200 ${
              isFocused
                ? "border-primary shadow-lg shadow-primary/10"
                : "border-border"
            }`}
          >
            <Search className="absolute left-5 h-5 w-5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder={t("placeholderHero")}
              value={inputValue}
              onChange={handleInputChange}
              onFocus={() => setIsFocused(true)}
              autoFocus={autoFocus}
              className="w-full h-full pl-13 pr-16 bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none rounded-full"
            />
            {inputValue && (
              <button
                type="button"
                onClick={clearInput}
                className="absolute right-16 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              className="absolute right-1 w-[48px] h-[48px] rounded-full bg-primary hover:bg-primary/80 flex items-center justify-center transition-colors shrink-0"
            >
              <Search className="h-5 w-5 text-white" />
            </button>
          </div>
        </form>

        {/* Parsed tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2 px-2">
            {tags.map((tag) => (
              <span
                key={tag.key}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary/70 text-xs font-medium"
              >
                {tag.label}
                <button
                  type="button"
                  onClick={() => removeTag(tag.key)}
                  className="hover:text-primary/70 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Dropdown suggestions */}
        {showDropdown && (
          <div className="absolute top-full left-0 right-0 z-50 mt-2 bg-card border border-border rounded-2xl shadow-lg overflow-hidden">
            {/* Recent searches */}
            {recentSearches.length > 0 && (
              <div className="p-4">
                <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  {t("recentSearches")}
                </h4>
                <div className="space-y-0.5">
                  {recentSearches.map((search) => (
                    <button
                      key={search}
                      type="button"
                      onClick={() => handleSuggestionClick(search)}
                      className="w-full text-left px-3 py-2 text-sm text-foreground rounded-lg hover:bg-muted transition-colors"
                    >
                      {search}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Popular searches */}
            <div
              className={`p-4 ${recentSearches.length > 0 ? "border-t border-border" : ""}`}
            >
              <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3" />
                {t("popularSearches")}
              </h4>
              <div className="space-y-0.5">
                {POPULAR_SEARCHES.map((search, index) => (
                  <button
                    key={search}
                    type="button"
                    onClick={() => handleSuggestionClick(search)}
                    className="w-full text-left px-3 py-2 text-sm text-foreground rounded-lg hover:bg-muted transition-colors flex items-center gap-2"
                  >
                    <span className="text-xs font-bold text-primary/70 w-4 text-center">
                      {index + 1}
                    </span>
                    {search}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Default / compact mode (unchanged) ─────────────────────────────
  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <form onSubmit={handleSubmit}>
        <div
          className={`relative flex items-center ${compact ? "" : "max-w-2xl mx-auto"}`}
        >
          <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder={t("placeholderDefault")}
            value={inputValue}
            onChange={handleInputChange}
            onFocus={() => setIsFocused(true)}
            autoFocus={autoFocus}
            className={`pl-10 pr-10 ${compact ? "h-9" : "h-12 text-base"} bg-background border-border`}
          />
          {inputValue && (
            <button
              type="button"
              onClick={clearInput}
              className="absolute right-3 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </form>

      {/* Parsed tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {tags.map((tag) => (
            <span
              key={tag.key}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary/70 text-xs font-medium"
            >
              {tag.label}
              <button
                type="button"
                onClick={() => removeTag(tag.key)}
                className="hover:text-primary/70 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Dropdown suggestions */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 z-50 mt-2 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
          {/* Recent searches */}
          {recentSearches.length > 0 && (
            <div className="p-3">
              <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                최근 검색어
              </h4>
              <div className="space-y-0.5">
                {recentSearches.map((search) => (
                  <button
                    key={search}
                    type="button"
                    onClick={() => handleSuggestionClick(search)}
                    className="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-muted transition-colors"
                  >
                    {search}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Popular searches */}
          <div
            className={`p-3 ${recentSearches.length > 0 ? "border-t border-border" : ""}`}
          >
            <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" />
              {t("popularSearches")}
            </h4>
            <div className="space-y-0.5">
              {POPULAR_SEARCHES.map((search, index) => (
                <button
                  key={search}
                  type="button"
                  onClick={() => handleSuggestionClick(search)}
                  className="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-muted transition-colors flex items-center gap-2"
                >
                  <span className="text-xs font-bold text-primary/70 w-4 text-center">
                    {index + 1}
                  </span>
                  {search}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
