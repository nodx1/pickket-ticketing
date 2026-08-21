import Link from "next/link";
import { ChevronRight, Clock, CreditCard, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export function OrganizerCTASection() {
  return (
    <section className="mx-auto max-w-7xl px-6 pb-20 lg:px-10">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-accent/10 p-10 backdrop-blur-sm lg:p-16">
        {/* 배경 장식 */}
        <div className="pointer-events-none absolute -right-20 -top-20 h-96 w-96 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-20 h-96 w-96 rounded-full bg-gradient-to-tr from-success/10 to-accent/10 blur-3xl" />

        <div className="relative">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary">
            READY TO START
          </p>
          <h2 className="mt-4 text-4xl font-black tracking-[-0.04em] text-foreground sm:text-5xl">
            지금 바로,
            <br />
            <span className="text-primary">이벤트를 시작하세요.</span>
          </h2>

          <div className="mt-8 max-w-2xl space-y-1 text-xl font-bold text-foreground sm:text-2xl">
            <p>만드는 데 5분,</p>
            <p>파는 것도 5분.</p>
            <p className="text-muted-foreground">운영은 알아서 돌아갑니다.</p>
          </div>

          <p className="mt-6 max-w-2xl text-base leading-8 text-muted-foreground">
            디자이너 · 개발자 · 회계사 없이도 됩니다. 신용카드 등록 없이 무료로 시작하고,
            실제로 판매가 일어난 만큼만 수수료를 냅니다.
          </p>

          {/* 신뢰 뱃지 */}
          <div className="mt-8 flex flex-wrap gap-3">
            <div className="flex items-center gap-2 rounded-full border border-border bg-card/80 px-4 py-2 text-sm font-medium text-muted-foreground backdrop-blur">
              <Shield className="size-4 text-success" />
              신용카드 필요 없음
            </div>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card/80 px-4 py-2 text-sm font-medium text-muted-foreground backdrop-blur">
              <CreditCard className="size-4 text-primary" />
              판매되는 만큼만 수수료
            </div>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card/80 px-4 py-2 text-sm font-medium text-muted-foreground backdrop-blur">
              <Clock className="size-4 text-accent" />
              5분 만에 첫 이벤트
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/register">
                무료 계정 만들기
                <ChevronRight className="size-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/about">더 알아보기</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
