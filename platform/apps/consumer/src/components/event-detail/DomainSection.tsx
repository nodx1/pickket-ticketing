"use client";
import Image from "next/image";
import { type LucideIcon } from "lucide-react";
import { motion } from "motion/react";

interface DomainSectionProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  iconSrc?: string;
  accentColor?: string;
  children: React.ReactNode;
}

export default function DomainSection({
  title,
  subtitle,
  icon: Icon,
  iconSrc,
  accentColor,
  children,
}: DomainSectionProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] overflow-hidden"
    >
      {accentColor && <div className={`h-1 ${accentColor}`} />}
      <div className="p-5 md:p-6">
        <div className="flex items-center gap-2.5 mb-4">
          {iconSrc ? (
            <Image
              src={iconSrc}
              alt=""
              width={20}
              height={20}
              className="shrink-0 dark:invert"
            />
          ) : Icon ? (
            <Icon className="h-5 w-5 text-primary shrink-0" />
          ) : null}
          <div>
            <h3 className="text-base font-bold text-foreground">{title}</h3>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        {children}
      </div>
    </motion.div>
  );
}
