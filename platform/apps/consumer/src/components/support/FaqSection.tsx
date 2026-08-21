"use client";

import { useState } from "react";
import {
  ShoppingCart,
  CreditCard,
  Repeat,
  User,
  ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";

type FaqCategory = "purchase" | "payment" | "resale" | "account";

interface FaqItem {
  q: string;
  a: string;
}

const CATEGORY_ICONS: Record<FaqCategory, React.ElementType> = {
  purchase: ShoppingCart,
  payment: CreditCard,
  resale: Repeat,
  account: User,
};

export default function FaqSection() {
  const t = useTranslations("support.faq");
  const [activeCategory, setActiveCategory] = useState<FaqCategory>("purchase");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const CATEGORIES: {
    key: FaqCategory;
    label: string;
    icon: React.ElementType;
  }[] = [
    { key: "purchase", label: t("category.purchase"), icon: CATEGORY_ICONS.purchase },
    { key: "payment", label: t("category.payment"), icon: CATEGORY_ICONS.payment },
    { key: "resale", label: t("category.resale"), icon: CATEGORY_ICONS.resale },
    { key: "account", label: t("category.account"), icon: CATEGORY_ICONS.account },
  ];

  const FAQ_DATA: Record<FaqCategory, FaqItem[]> = {
    purchase: [
      {
        q: t("purchase.q1"),
        a: t("purchase.a1"),
      },
      {
        q: t("purchase.q2"),
        a: t("purchase.a2"),
      },
      {
        q: t("purchase.q3"),
        a: t("purchase.a3"),
      },
    ],
    payment: [
      {
        q: t("payment.q1"),
        a: t("payment.a1"),
      },
      {
        q: t("payment.q2"),
        a: t("payment.a2"),
      },
      {
        q: t("payment.q3"),
        a: t("payment.a3"),
      },
    ],
    resale: [
      {
        q: t("resale.q1"),
        a: t("resale.a1"),
      },
      {
        q: t("resale.q2"),
        a: t("resale.a2"),
      },
      {
        q: t("resale.q3"),
        a: t("resale.a3"),
      },
    ],
    account: [
      {
        q: t("account.q1"),
        a: t("account.a1"),
      },
      {
        q: t("account.q2"),
        a: t("account.a2"),
      },
    ],
  };

  const toggleItem = (index: number) => {
    setOpenIndex((prev) => (prev === index ? null : index));
  };

  const handleCategoryChange = (cat: FaqCategory) => {
    setActiveCategory(cat);
    setOpenIndex(null);
  };

  return (
    <div className="space-y-5">
      {/* Category tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {CATEGORIES.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => handleCategoryChange(key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium flex-shrink-0 transition-colors ${
              activeCategory === key
                ? "bg-primary text-white"
                : "bg-surface-dim text-muted-foreground hover:bg-muted"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* FAQ items */}
      <div className="space-y-2">
        {FAQ_DATA[activeCategory].map((item, i) => (
          <div
            key={item.q}
            className="bg-card rounded-xl border border-border overflow-hidden"
          >
            <button
              onClick={() => toggleItem(i)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-left"
            >
              <span className="text-sm font-medium text-foreground pr-4">
                {item.q}
              </span>
              <motion.div
                animate={{ rotate: openIndex === i ? 180 : 0 }}
                transition={{ duration: 0.2 }}
                className="flex-shrink-0"
              >
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </motion.div>
            </button>
            <AnimatePresence>
              {openIndex === i && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
                    {item.a}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}
