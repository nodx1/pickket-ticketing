"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { springs } from "@/lib/motion/spring-configs";

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
}

export function ScrollReveal({ children, className }: ScrollRevealProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ type: "spring", ...springs.gentle }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
