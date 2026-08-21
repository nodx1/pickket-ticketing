"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";

interface LineupItem {
  name: string;
  role?: string;
  image_url?: string;
}

interface LineupGridProps {
  lineup: LineupItem[];
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function LineupGrid({ lineup }: LineupGridProps) {
  const t = useTranslations("event.lineupGrid");
  if (lineup.length === 0) return null;

  return (
    <div className="space-y-6">
      <h3 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground flex items-center gap-4">
        <span className="h-1 w-10 bg-primary rounded-full" />
        {t("title")}
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
        {lineup.map((item, i) => (
          <motion.div
            key={`${item.name}-${i}`}
            className="flex flex-col items-center gap-4 text-center group cursor-default"
            whileHover={{ scale: 1.03 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            <div className="w-24 h-24 rounded-full overflow-hidden ring-2 ring-primary/20 group-hover:ring-primary transition-all p-1">
              {item.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.image_url}
                  alt={item.name}
                  className="w-full h-full object-cover rounded-full"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center rounded-full bg-card text-muted-foreground text-lg font-bold">
                  {getInitials(item.name)}
                </div>
              )}
            </div>
            <div>
              <p className="font-bold text-lg text-foreground">{item.name}</p>
              {item.role && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {item.role}
                </p>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
