import type { Variants } from "motion/react";
import { springs } from "./spring-configs";

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { type: "spring", ...springs.gentle } },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { type: "spring", ...springs.gentle } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { type: "spring", ...springs.snappy } },
};

export const stagger = {
  visible: {
    transition: {
      staggerChildren: 0.06,
    },
  },
};

export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 16 },
  visible: { opacity: 1, x: 0, transition: { type: "spring", ...springs.fluid } },
};
