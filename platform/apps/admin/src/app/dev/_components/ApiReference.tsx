"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { apis, APIS_LAST_UPDATED, type HttpMethod } from "../_data/apis";
import type { PageStatus } from "../_data/pages";

const METHOD_COLOR: Record<HttpMethod, string> = {
  GET: "bg-blue-500/20 text-blue-400",
  POST: "bg-green-500/20 text-green-400",
  PATCH: "bg-yellow-500/20 text-yellow-400",
  PUT: "bg-orange-500/20 text-orange-400",
  DELETE: "bg-red-500/20 text-red-400",
};

const STATUS_COLOR: Record<PageStatus, string> = {
  done: "bg-green-500/20 text-green-400",
  wip: "bg-yellow-500/20 text-yellow-400",
  todo: "bg-[var(--pk-surface-2,#1a1a24)] text-[var(--pk-text-secondary)]",
};
const STATUS_LABEL_KEY: Record<PageStatus, string> = {
  done: "statusDone",
  wip: "statusWip",
  todo: "statusTodo",
};

const ALL_METHODS: (HttpMethod | "ALL")[] = [
  "ALL",
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
];
const ALL_MODS = ["ALL", ...Array.from(new Set(apis.map((a) => a.mod))).sort()];

export function ApiReference() {
  const t = useTranslations("dev.apiReference");
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState<HttpMethod | "ALL">("ALL");
  const [mod, setMod] = useState("ALL");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return apis.filter((a) => {
      if (method !== "ALL" && a.method !== method) return false;
      if (mod !== "ALL" && a.mod !== mod) return false;
      if (
        q &&
        !a.path.toLowerCase().includes(q) &&
        !a.fn.toLowerCase().includes(q) &&
        !a.mod.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [query, method, mod]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: apis.length };
    for (const a of apis) c[a.method] = (c[a.method] ?? 0) + 1;
    return c;
  }, []);

  return (
    <div className="space-y-4">
      {/* 데이터 신선도 */}
      <p className="text-xs text-[var(--pk-text-secondary)]">
        {t("manualUpdate")}: <span className="font-mono">{APIS_LAST_UPDATED}</span>
        {" · "}
        <span className="text-[var(--pk-text-secondary)]">
          {t("editHint")}
        </span>
      </p>
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

        {/* Method 필터 */}
        <div className="flex flex-wrap gap-1.5">
          {ALL_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                method === m
                  ? "bg-[var(--pk-accent)] text-white"
                  : "border border-[var(--pk-border)] text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)]"
              }`}
            >
              {m}
              {m !== "ALL" && counts[m]
                ? ` (${counts[m]})`
                : m === "ALL"
                  ? ` (${apis.length})`
                  : ""}
            </button>
          ))}
        </div>

        {/* Module 필터 */}
        <div className="flex flex-wrap gap-1.5">
          {ALL_MODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMod(m)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                mod === m
                  ? "bg-[var(--pk-accent)] text-white"
                  : "border border-[var(--pk-border)] text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* 결과 수 */}
      <p className="text-xs text-[var(--pk-text-secondary)]">
        {t("resultCount", { filtered: filtered.length, total: apis.length })}
      </p>

      {/* 테이블 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--pk-border)] bg-[var(--pk-surface-2,#1a1a24)]">
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-20">
                  Method
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Path
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-24 hidden sm:table-cell">
                  Module
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] hidden md:table-cell">
                  Function
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-[var(--pk-text-secondary)] w-20">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pk-border)]">
              {filtered.map((api, i) => (
                <tr
                  key={i}
                  className="hover:bg-[var(--pk-surface-2,#1a1a24)] transition-colors"
                >
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLOR[api.method]}`}
                    >
                      {api.method}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--pk-text)]">
                    <span className="text-[var(--pk-text-secondary)]">
                      /api/v1
                    </span>
                    {api.path}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] hidden sm:table-cell">
                    {api.mod}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] font-mono hidden md:table-cell">
                    {api.fn}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLOR[api.status]}`}
                    >
                      {t(STATUS_LABEL_KEY[api.status])}
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
