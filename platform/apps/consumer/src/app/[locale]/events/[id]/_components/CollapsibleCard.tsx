"use client";

import { useState, useId } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { CARD } from "@/lib/styles";

interface CollapsibleCardProps {
  title: string;
  icon?: LucideIcon;
  defaultOpen?: boolean;
  /** span columns in bento grid */
  span?: "full" | "half";
  children: React.ReactNode;
}

export function CollapsibleCard({
  title,
  icon: Icon,
  defaultOpen = false,
  span = "half",
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;

  return (
    <div
      className={`group/card ${CARD.shell} transition-all duration-300 hover:border-border hover:shadow-sm ${
        span === "full" ? "col-span-full" : ""
      }`}
    >
      <button
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-primary/[0.04] transition-all duration-200"
      >
        {Icon && (
          <span className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10 shrink-0 group-hover/card:bg-primary/20 transition-colors">
            <Icon className="h-4 w-4 text-primary" />
          </span>
        )}
        <span className="flex-1 text-base font-bold text-foreground tracking-tight">
          {title}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-5 py-5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
