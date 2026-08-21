"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";

import AdminSidebar from "./AdminSidebar";

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  onLogout?: () => void;
}

export default function MobileSidebar({
  open,
  onClose,
  onLogout,
}: MobileSidebarProps) {
  const t = useTranslations("mobileSidebar");
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <motion.button
            type="button"
            className="absolute inset-0 bg-black/60"
            onClick={onClose}
            aria-label={t("closeSidebar")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t("navigationMenu")}
            className="absolute top-14 left-0 bottom-0 w-[220px] shadow-2xl"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
          >
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="absolute top-3 right-3 z-10 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-sm"
              aria-label={t("closeMenu")}
            >
              <X className="h-4 w-4" />
            </button>
            <AdminSidebar
              mode="mobile"
              onNavigate={onClose}
              onLogout={onLogout}
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
