"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

interface SearchInputProps {
  defaultValue?: string;
  placeholder?: string;
  onSearch: (value: string) => void;
}

export function SearchInput({
  defaultValue = "",
  placeholder = "검색어 입력…",
  onSearch,
}: SearchInputProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onSearch(value);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [value, onSearch]);

  return (
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-11"
      />
    </div>
  );
}
