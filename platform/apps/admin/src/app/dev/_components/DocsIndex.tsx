"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, FileText } from "lucide-react";
import { docs, type DocCategory } from "../_data/docs";

const CAT_STYLE: Record<DocCategory, string> = {
  architecture: "bg-[#6c5ce7]/20 text-[#6c5ce7]",
  business: "bg-[#00d2a0]/20 text-[#00d2a0]",
  checklists: "bg-[#22c55e]/20 text-[#22c55e]",
  operations: "bg-[#f97316]/20 text-[#f97316]",
  guides: "bg-[#eab308]/20 text-[#eab308]",
  prototypes: "bg-[#ec4899]/20 text-[#ec4899]",
  archive: "bg-[#8888aa]/20 text-[#8888aa]",
  status: "bg-[#a855f7]/20 text-[#a855f7]",
  prompts: "bg-[#0ea5e9]/20 text-[#0ea5e9]",
  legal: "bg-[#ef4444]/20 text-[#ef4444]",
};

const CAT_LABEL: Record<DocCategory, string> = {
  architecture: "Architecture",
  business: "Business",
  checklists: "Checklists",
  operations: "Operations",
  guides: "Guides",
  prototypes: "Prototypes",
  archive: "Archive",
  status: "Status",
  prompts: "Prompts",
  legal: "Legal",
};

const ALL_CATS = [
  "all",
  ...Array.from(new Set(docs.map((d) => d.cat))).sort(),
] as (DocCategory | "all")[];

export function DocsIndex() {
  const t = useTranslations("dev.docsIndex");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<DocCategory | "all">("all");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return docs.filter((d) => {
      if (cat !== "all" && d.cat !== cat) return false;
      if (
        q &&
        !d.file.toLowerCase().includes(q) &&
        !d.desc.toLowerCase().includes(q) &&
        !d.cat.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [query, cat]);

  const catCounts = useMemo(() => {
    const c: Record<string, number> = { all: docs.length };
    for (const d of docs) c[d.cat] = (c[d.cat] ?? 0) + 1;
    return c;
  }, []);

  // Determine folder path for a doc
  const getPath = (d: { cat: DocCategory; file: string }) => {
    const folderMap: Partial<Record<DocCategory, string>> = {
      architecture: "docs/architecture/",
      business: "docs/business/",
      checklists: "docs/operations/",
      operations: "docs/operations/",
      guides: "docs/guides/",
      prototypes: "docs/prototypes/",
      archive: "docs/archive/",
      status: "docs/",
      prompts: "docs/",
      legal: "docs/legal/",
    };
    return `${folderMap[d.cat] ?? "docs/"}${d.file}`;
  };

  return (
    <div className="space-y-4">
      {/* 검색 + 카테고리 필터 */}
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
        <div className="flex flex-wrap gap-1.5">
          {ALL_CATS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                cat === c
                  ? "bg-[var(--pk-accent)] text-white"
                  : "border border-[var(--pk-border)] text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)]"
              }`}
            >
              {c === "all" ? t("allCategories") : CAT_LABEL[c as DocCategory]} (
              {catCounts[c] ?? 0})
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-[var(--pk-text-secondary)]">
        {t("docCount", { filtered: filtered.length, total: docs.length })}
      </p>

      {/* 카드 리스트 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
        <div className="divide-y divide-[var(--pk-border)]">
          {filtered.map((doc, i) => (
            <div
              key={i}
              className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--pk-surface-2,#1a1a2e)] transition-colors"
            >
              <FileText className="h-4 w-4 text-[var(--pk-text-secondary)] shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CAT_STYLE[doc.cat]}`}
                  >
                    {CAT_LABEL[doc.cat]}
                  </span>
                  <span className="text-xs font-mono font-semibold text-[var(--pk-text)] truncate">
                    {doc.file}
                  </span>
                </div>
                <p className="text-xs text-[var(--pk-text-secondary)] mt-0.5">
                  {doc.desc}
                </p>
                <p className="text-[10px] font-mono text-[var(--pk-text-secondary)] mt-0.5 opacity-60">
                  {getPath(doc)}
                </p>
              </div>
            </div>
          ))}
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
