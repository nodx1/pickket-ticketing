"use client";

import { Shapes } from "lucide-react";
import { cn } from "@/lib/utils";

export type BuilderMode = "grid" | "visual" | "figma";

interface BuilderModeTabsProps {
  mode: BuilderMode;
  onChange: (mode: BuilderMode) => void;
}

// 격자/시각 모드는 임시 숨김 (피그마 모드로 통합). 기존 데이터 호환성 위해 타입은 유지.
// 다시 노출하려면 아래 배열에 {value, label, icon} 추가하면 됨.
export function BuilderModeTabs({ mode, onChange }: BuilderModeTabsProps) {
  return (
    <div className="inline-flex rounded-lg border border-border p-1">
      <button
        type="button"
        onClick={() => onChange("figma")}
        className={cn(
          "flex items-center gap-2 rounded px-4 py-2 text-sm font-medium transition-colors",
          mode === "figma" || mode === "grid" || mode === "visual"
            ? "bg-primary text-white"
            : "text-muted-foreground hover:bg-muted",
        )}
      >
        <Shapes className="size-4" />
        배치도 에디터
      </button>
    </div>
  );
}
