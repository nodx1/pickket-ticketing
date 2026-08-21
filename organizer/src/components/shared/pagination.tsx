"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <div className="flex items-center justify-center gap-2">
      <Button variant="outline" size="icon" aria-label="이전 페이지" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        <ChevronLeft className="size-4" />
      </Button>
      {pages.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onPageChange(item)}
          aria-current={item === page ? "page" : undefined}
          className={cn(
            "flex size-10 items-center justify-center rounded-full text-sm font-semibold transition",
            item === page ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {item}
        </button>
      ))}
      <Button variant="outline" size="icon" aria-label="다음 페이지" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
