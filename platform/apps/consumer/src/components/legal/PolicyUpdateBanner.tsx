"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { FileText, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { POLICY_VERSION, POLICY_CHANGES } from "@pickket/lib";

const STORAGE_KEY = "pickket_policy_acknowledged";

function getAcknowledgedVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const POLICY_ROUTES: Record<string, string> = {
  terms: "/terms",
  privacy: "/privacy",
  refund: "/refund-policy",
  youth: "/youth-protection",
};

export default function PolicyUpdateBanner() {
  const t = useTranslations("policy");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const acked = getAcknowledgedVersion();
    if (!acked || acked < POLICY_VERSION) {
      setVisible(true);
    }
  }, []);

  const handleAcknowledge = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, POLICY_VERSION);
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        className="fixed top-16 left-0 right-0 z-40 bg-primary text-primary-foreground"
      >
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <FileText className="h-4 w-4 shrink-0" />
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 min-w-0">
              <span className="text-sm font-medium whitespace-nowrap">
                {t("update_title")}
              </span>
              <span className="hidden sm:inline text-sm opacity-75">|</span>
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                {POLICY_CHANGES.map((key, i) => (
                  <span key={key}>
                    <Link
                      href={POLICY_ROUTES[key] || "/terms"}
                      className="underline underline-offset-2 hover:opacity-80 transition-opacity"
                    >
                      {t(`changed_${key}`)}
                    </Link>
                    {i < POLICY_CHANGES.length - 1 && (
                      <span className="opacity-50 ml-1">·</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link
              href="/terms"
              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-white/20 hover:bg-white/30 text-sm font-medium transition-colors"
            >
              {t("view_details")}
            </Link>
            <button
              onClick={handleAcknowledge}
              className="p-1.5 rounded-full hover:bg-white/20 transition-colors"
              aria-label={t("acknowledge")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
