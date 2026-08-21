import type React from "react";

export interface PageTheme {
  accent?: string;
  accentLight?: string;
  accentGlow?: string;
  bg?: string;
  surface?: string;
  text?: string;
  textSecondary?: string;
  fair?: string;
  hot?: string;
  logoUrl?: string;
  ogImage?: string;
}

const THEME_MAP: Record<keyof Omit<PageTheme, "logoUrl" | "ogImage">, string> =
  {
    accent: "--pk-accent",
    accentLight: "--pk-accent-light",
    accentGlow: "--pk-accent-glow",
    bg: "--pk-bg",
    surface: "--pk-surface",
    text: "--pk-text",
    textSecondary: "--pk-text-secondary",
    fair: "--pk-fair",
    hot: "--pk-hot",
  };

export const DEFAULT_THEME: PageTheme = {
  accent: "#0a0a0a",
  accentLight: "#d4d4d4",
  accentGlow: "rgba(10,10,10,0.5)",
  bg: "#0a0a0c",
  surface: "#141418",
  text: "#f1f1f3",
  textSecondary: "#8e8e9a",
  fair: "#00d2a0",
  hot: "#ff6b6b",
};

export function themeToCSS(
  theme: PageTheme | null | undefined,
): React.CSSProperties {
  const merged = { ...DEFAULT_THEME, ...theme };
  const style: Record<string, string> = {};
  for (const [key, cssVar] of Object.entries(THEME_MAP)) {
    const value = merged[key as keyof PageTheme];
    if (value && typeof value === "string") {
      style[cssVar] = value;
    }
  }
  return style as React.CSSProperties;
}
