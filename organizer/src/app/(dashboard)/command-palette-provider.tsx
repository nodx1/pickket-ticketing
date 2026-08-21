"use client";

import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { useCommandPalette } from "@/lib/stores/commandPaletteStore";

export function CommandPaletteProvider() {
  const toggle = useCommandPalette((state) => state.toggle);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return <CommandPalette />;
}
