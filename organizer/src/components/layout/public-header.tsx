"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * 공개 헤더. 이벤트 랜딩(/e/*)에서는 주최자 CTA(주최자 로그인·무료로 시작)를 숨기고
 * 구매자 액션(이벤트 찾기·내 티켓) 중심으로 간결하게 렌더한다. 그 외 페이지는 전체 헤더.
 */
export function PublicHeader() {
  const pathname = usePathname();
  const compact = pathname?.startsWith("/e/") ?? false;

  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-background/80 backdrop-blur-lg">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link href="/" className="text-lg font-black tracking-[-0.04em] text-foreground">
          PICKKET.GO
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/#events" className="text-content-subtle hover:text-foreground">이벤트 찾기</Link>
          <Link href="/my-tickets" className="text-content-subtle hover:text-foreground">내 티켓</Link>
          {!compact ? (
            <div className="hidden items-center gap-2 sm:flex">
              <Button variant="ghost" size="sm" asChild>
                <Link href="/login">주최자 로그인</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/register">무료로 시작</Link>
              </Button>
            </div>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
