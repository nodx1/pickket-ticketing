"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { checklist, type ItemStatus } from "../_data/checklist";

const STATUS_ORDER: ItemStatus[] = ["todo", "wip", "done"];
const STATUS_LABEL_KEYS: Record<ItemStatus, string> = {
  done: "statusDone",
  wip: "statusWip",
  todo: "statusTodo",
};
const STATUS_COLOR: Record<ItemStatus, string> = {
  done: "bg-green-500/20 text-green-400 border-green-500/30",
  wip: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  todo: "bg-[var(--pk-surface-2,#1a1a24)] text-[var(--pk-text-secondary)] border-[var(--pk-border)]",
};
const STATUS_BAR_COLOR: Record<ItemStatus, string> = {
  done: "#22c55e",
  wip: "#eab308",
  todo: "#6b7280",
};

const STORAGE_KEY = "pickket_dev_checklist";

type StatusMap = Record<string, ItemStatus>;

function loadOverrides(): StatusMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function LaunchChecklist() {
  const t = useTranslations("dev.launchChecklist");
  const [overrides, setOverrides] = useState<StatusMap>({});

  useEffect(() => {
    setOverrides(loadOverrides());
  }, []);

  const getStatus = (id: string, initial: ItemStatus): ItemStatus =>
    overrides[id] ?? initial;

  const cycleStatus = (id: string, current: ItemStatus) => {
    const next =
      STATUS_ORDER[(STATUS_ORDER.indexOf(current) + 1) % STATUS_ORDER.length];
    const updated = { ...overrides, [id]: next };
    setOverrides(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const resetAll = () => {
    setOverrides({});
    localStorage.removeItem(STORAGE_KEY);
  };

  // Global stats
  let totalAll = 0,
    doneAll = 0,
    wipAll = 0;
  checklist.forEach((sec) =>
    sec.items.forEach((item) => {
      const s = getStatus(item.id, item.status);
      totalAll++;
      if (s === "done") doneAll++;
      if (s === "wip") wipAll++;
    }),
  );
  const donePct = Math.round((doneAll / totalAll) * 100);
  const wipPct = Math.round((wipAll / totalAll) * 100);

  return (
    <div className="space-y-5">
      {/* 전체 진행률 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-[var(--pk-text)]">
            {t("overallProgress")}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--pk-text-secondary)]">
              {t("done")} <strong className="text-green-400">{doneAll}</strong> /
              {t("wip")} <strong className="text-yellow-400">{wipAll}</strong> /
              {t("total")} {totalAll}
            </span>
            <button
              type="button"
              onClick={resetAll}
              className="text-xs text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)] underline"
            >
              {t("reset")}
            </button>
          </div>
        </div>
        <div className="h-3 bg-[var(--pk-surface-2,#1a1a24)] rounded-full overflow-hidden">
          <div className="h-full flex">
            <div
              className="h-full transition-all duration-700"
              style={{ width: `${donePct}%`, backgroundColor: "#22c55e" }}
            />
            <div
              className="h-full transition-all duration-700"
              style={{ width: `${wipPct}%`, backgroundColor: "#eab308" }}
            />
          </div>
        </div>
        <div className="flex justify-between text-xs text-[var(--pk-text-secondary)] mt-1">
          <span className="text-green-400">{t("pctDone", { pct: donePct })}</span>
          <span className="text-yellow-400">{t("pctWip", { pct: wipPct })}</span>
          <span>{t("pctTodo", { pct: 100 - donePct - wipPct })}</span>
        </div>
      </div>

      {/* 섹션 카드 그리드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {checklist.map((section) => {
          const items = section.items.map((i) => ({
            ...i,
            current: getStatus(i.id, i.status),
          }));
          const done = items.filter((i) => i.current === "done").length;
          const wip = items.filter((i) => i.current === "wip").length;
          const total = items.length;
          const secDonePct = Math.round((done / total) * 100);

          return (
            <div
              key={section.id}
              className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4"
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-semibold text-[var(--pk-text)]">
                  {section.title}
                </h3>
                <span className="text-xs text-[var(--pk-text-secondary)] shrink-0 ml-2">
                  {t("sectionDone", { done, total })}
                  {wip > 0 && (
                    <span className="text-yellow-400 ml-1">{t("sectionWip", { wip })}</span>
                  )}
                </span>
              </div>

              {/* 섹션 진행률 바 */}
              <div className="h-1.5 bg-[var(--pk-surface-2,#1a1a24)] rounded-full overflow-hidden mb-3">
                <div className="h-full flex">
                  <div
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${secDonePct}%`,
                      backgroundColor: STATUS_BAR_COLOR.done,
                    }}
                  />
                  <div
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${Math.round((wip / total) * 100)}%`,
                      backgroundColor: STATUS_BAR_COLOR.wip,
                    }}
                  />
                </div>
              </div>

              {/* 항목 목록 */}
              <ul className="space-y-1.5">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => cycleStatus(item.id, item.current)}
                      className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--pk-surface-2,#1a1a24)] transition-colors text-left group"
                    >
                      <span
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${STATUS_COLOR[item.current]}`}
                      >
                        {t(STATUS_LABEL_KEYS[item.current])}
                      </span>
                      <span
                        className={`text-xs flex-1 ${item.current === "done" ? "line-through text-[var(--pk-text-secondary)]" : "text-[var(--pk-text)]"}`}
                      >
                        {item.label}
                      </span>
                      <span className="text-[var(--pk-text-secondary)] text-[10px] opacity-0 group-hover:opacity-100 shrink-0">
                        {t("clickHint")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
