"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { Button } from "@pickket/ui";
import { useTranslations } from "next-intl";

export default function ThemeToggle({
  overlay: _overlay = false,
}: {
  overlay?: boolean;
}) {
  const t = useTranslations("common.themeToggle");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = theme === "dark";
  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  const iconColor = "text-white/80";
  const hoverBg = "hover:bg-white/10";

  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={`h-10 w-10 rounded-full ${iconColor} ${hoverBg}`}
        aria-label={t("toggle")}
      >
        <Sun className="h-6 w-6" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-10 w-10 rounded-full ${iconColor} hover:text-foreground ${hoverBg}`}
      onClick={toggleTheme}
      aria-label={isDark ? t("switchToLight") : t("switchToDark")}
      aria-pressed={isDark}
    >
      <Sun className="h-6 w-6 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-6 w-6 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
    </Button>
  );
}
