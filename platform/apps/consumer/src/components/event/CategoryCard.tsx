"use client";

import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { CATEGORIES } from "@pickket/lib";

const CATEGORY_ICONS: Record<string, string> = {
  concert: "/icons/categories/concert.svg",
  musical: "/icons/categories/musical.svg",
  sports: "/icons/categories/sports.svg",
  classical: "/icons/categories/classical.svg",
  exhibition: "/icons/categories/exhibition.svg",
  festival: "/icons/categories/festival.svg",
  education: "/icons/categories/education.svg",
  civic: "/icons/categories/civic.svg",
};

/* Gradient pairs derived from category colors */
const CATEGORY_GRADIENTS: Record<string, string> = {
  concert: "from-[#FF6B6B] to-[#EE5A24]",
  musical: "from-[#4ECDC4] to-[#2C9E8F]",
  sports: "from-[#45B7D1] to-[#2E86AB]",
  classical: "from-[#96CEB4] to-[#6BAA8E]",
  exhibition: "from-[#FFEAA7] to-[#FDCB6E]",
  festival: "from-[#DDA0DD] to-[#C47AC0]",
  education: "from-[#5DADE2] to-[#2E86AB]",
  civic: "from-[#48C9B0] to-[#1ABC9C]",
};

interface CategoryCardProps {
  slug: string;
  label: string;
  icon: string;
  color: string;
  count?: number;
}

function CategoryCardItem({ slug, label, count }: CategoryCardProps) {
  const t = useTranslations("event.categoryCard");
  const iconSrc = CATEGORY_ICONS[slug] || CATEGORY_ICONS.concert;
  const gradient = CATEGORY_GRADIENTS[slug] || "from-primary to-primary/80";

  return (
    <Link href={`/category/${slug}`}>
      <div
        className={`group relative flex flex-col items-center justify-center gap-2.5 p-5 rounded-2xl bg-gradient-to-br ${gradient}
          hover:-translate-y-1 hover:shadow-xl transition-all duration-300 cursor-pointer overflow-hidden aspect-square sm:aspect-[4/3]`}
      >
        {/* Subtle shine effect on hover */}
        <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors duration-300 rounded-2xl" />

        {/* Icon */}
        <div className="relative z-10 h-12 w-12 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm group-hover:scale-110 transition-transform duration-300">
          <Image
            src={iconSrc}
            alt={label}
            width={24}
            height={24}
            className="brightness-0 invert drop-shadow"
          />
        </div>

        {/* Label */}
        <div className="relative z-10 text-center">
          <p className="font-semibold text-sm text-white drop-shadow">
            {label}
          </p>
          {count !== undefined && (
            <p className="text-xs-plus text-white/70 mt-0.5">
              {t("eventCount", { count: count ?? 0 })}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

interface CategoryGridProps {
  counts?: Record<string, number>;
}

export default function CategoryGrid({ counts }: CategoryGridProps) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {CATEGORIES.map((cat) => (
        <CategoryCardItem
          key={cat.slug}
          slug={cat.slug}
          label={cat.label}
          icon={cat.icon}
          color={cat.color}
          count={counts?.[cat.slug]}
        />
      ))}
    </div>
  );
}

export { CategoryCardItem };
