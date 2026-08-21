"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { pages, PAGES_LAST_UPDATED, type PageStatus } from "../_data/pages";

type AppFilter = "all" | "consumer" | "go" | "admin";

const APP_COLOR: Record<string, string> = {
  consumer: "bg-[#6c5ce7]/20 text-[#6c5ce7]",
  go: "bg-[#00d2a0]/20 text-[#00d2a0]",
  admin: "bg-[#f97316]/20 text-[#f97316]",
};

const STATUS_COLOR: Record<PageStatus, string> = {
  done: "bg-green-500/20 text-green-400",
  wip: "bg-yellow-500/20 text-yellow-400",
  todo: "bg-[var(--pk-surface-2,#1a1a24)] text-[var(--pk-text-secondary)]",
};
const STATUS_LABEL_KEYS: Record<PageStatus, string> = {
  done: "statusDone",
  wip: "statusWip",
  todo: "statusTodo",
};

export function PageMap() {
  const t = useTranslations("dev.pageMap");
  const [query, setQuery] = useState("");
  const [app, setApp] = useState<AppFilter>("all");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return pages.filter((p) => {
      if (app !== "all" && p.app !== app) return false;
      if (
        q &&
        !p.route.toLowerCase().includes(q) &&
        !p.cat.toLowerCase().includes(q) &&
        !p.api.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [query, app]);

  // Summary counts
  const summary = useMemo(() => {
    const s = { done: 0, wip: 0, todo: 0 };
    pages.forEach((p) => s[p.status]++);
    return s;
  }, []);

  const appCounts = useMemo(() => {
    const c: Record<string, number> = { all: pages.length };
    for (const p of pages) c[p.app] = (c[p.app] ?? 0) + 1;
    return c;
  }, []);

  return (
    <div className="space-y-4">
      {/* 데이터 신선도 */}
      <p className="text-xs text-[var(--pk-text-secondary)]">
        {t("manualUpdate")}: <span className="font-mono">{PAGES_LAST_UPDATED}</span>
        {" · "}
        <span className="text-[var(--pk-text-secondary)]">
          {t("editHint")}
        </span>
      </p>
      {/* 요약 카운트 */}
      <div className="grid grid-cols-3 gap-3">
        {(["done", "wip", "todo"] as PageStatus[]).map((s) => (
          <div
            key={s}
            className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-3 text-center"
          >
            <div
              className={`text-xl font-bold ${s === "done" ? "text-green-400" : s === "wip" ? "text-yellow-400" : "text-[var(--pk-text-secondary)]"}`}
            >
              {summary[s]}
            </div>
            <div className="text-xs text-[var(--pk-text-secondary)] mt-0.5">
              {t(STATUS_LABEL_KEYS[s])}
            </div>
          </div>
        ))}
      </div>

      {/* 검색 + 필터 */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--pk-text-secondary)]" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-[var(--pk-border)] bg-[var(--pk-surface)] pl-9 pr-4 py-2 text-sm text-[var(--pk-text)] placeholder:text-[var(--pk-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--pk-accent)]"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(["all", "consumer", "go", "admin"] as AppFilter[]).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setApp(a)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                app === a
                  ? "bg-[var(--pk-accent)] text-white"
                  : "border border-[var(--pk-border)] text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)]"
              }`}
            >
              {a === "all" ? t("filterAll") : a.charAt(0).toUpperCase() + a.slice(1)} (
              {appCounts[a] ?? 0})
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-[var(--pk-text-secondary)]">
        {t("pageCount", { filtered: filtered.length, total: pages.length })}
      </p>

      {/* 테이블 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--pk-border)] bg-[var(--pk-surface-2,#1a1a24)]">
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-20">
                  App
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Route
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-24 hidden sm:table-cell">
                  Category
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] hidden lg:table-cell">
                  Backend API
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] hidden md:table-cell">
                  Issues
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-20">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pk-border)]">
              {filtered.map((page, i) => (
                <tr
                  key={i}
                  className="hover:bg-[var(--pk-surface-2,#1a1a24)] transition-colors"
                >
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${APP_COLOR[page.app]}`}
                    >
                      {page.app}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--pk-text)]">
                    {page.route}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] hidden sm:table-cell">
                    {page.cat}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] hidden lg:table-cell max-w-xs truncate">
                    {page.api || "—"}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] hidden md:table-cell max-w-xs truncate">
                    {page.issues || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLOR[page.status]}`}
                    >
                      {t(STATUS_LABEL_KEYS[page.status])}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="p-8 text-center text-sm text-[var(--pk-text-secondary)]">
              {t("noResults")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
