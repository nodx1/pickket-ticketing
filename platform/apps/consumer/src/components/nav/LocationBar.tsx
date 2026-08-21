"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { MapPin, ChevronRight } from "lucide-react";
import { CITIES } from "@pickket/lib";

const STORAGE_KEY = "pickket_city";
const DEFAULT_CITY = "서울";

export default function LocationBar() {
  const t = useTranslations("nav.locationBar");
  const [city, setCity] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_CITY;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored || DEFAULT_CITY;
  });
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /* close dropdown on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    if (showDropdown) {
      document.addEventListener("mousedown", handler);
    }
    return () => document.removeEventListener("mousedown", handler);
  }, [showDropdown]);

  const handleSelectCity = (c: string) => {
    setCity(c);
    localStorage.setItem(STORAGE_KEY, c);
    setShowDropdown(false);
  };

  return (
    <div className="sticky bottom-0 z-30 flex items-center justify-center py-3 bg-background/80 backdrop-blur-sm border-t border-border">
      {/* Centered floating pill — TickPick style */}
      <div
        ref={dropdownRef}
        className="relative inline-flex items-center gap-3 px-5 py-2.5 rounded-full border border-border bg-card shadow-sm"
      >
        {/* City with icon */}
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 text-primary" />
          <span className="font-semibold text-foreground">{city}</span>
        </div>

        {/* Separator */}
        <div className="w-px h-4 bg-border" />

        {/* Edit button — plain text like TickPick */}
        <button
          type="button"
          onClick={() => setShowDropdown((prev) => !prev)}
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("changeCity")}
        </button>

        {/* Explore button — filled pill like TickPick */}
        <button
          type="button"
          className="flex items-center gap-1 px-4 py-1.5 rounded-full text-sm font-semibold bg-primary text-white hover:bg-brand-hover transition-colors"
        >
          {t("explore")}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        {/* City dropdown */}
        {showDropdown && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[300px] bg-card rounded-2xl border border-border shadow-xl p-4 animate-megaMenuIn">
            <p className="text-xs font-semibold text-muted-foreground mb-3 px-1">
              {t("selectRegion")}
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {CITIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => handleSelectCity(c)}
                  className={`px-2 py-2 text-xs rounded-xl text-center transition-colors ${
                    city === c
                      ? "bg-primary text-white font-semibold"
                      : "text-muted-foreground hover:bg-muted hover:text-primary"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
