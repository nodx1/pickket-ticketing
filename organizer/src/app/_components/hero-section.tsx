import Link from "next/link";
import { marketEventsUrl } from "@/lib/public/lottery-cta";
import {
  BarChart3,
  Calendar,
  ChevronRight,
  CreditCard,
  MapPin,
  Sparkles,
  Store,
  Ticket,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="relative mx-auto max-w-7xl px-6 pb-20 pt-28 lg:px-10">
      {/* 배경 그라디언트 ornament */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-gradient-to-br from-primary/20 via-accent/15 to-primary/5 blur-3xl" />
      </div>

      <div className="grid gap-12 lg:grid-cols-12 lg:items-center lg:gap-8">
        {/* 좌측: 카피 */}
        <div className="max-w-2xl animate-slide-up lg:col-span-7">
          <Badge variant="secondary" className="mb-6">
            <Sparkles className="mr-1.5 size-3" />
            이벤트를 여는 모든 사람을 위해
          </Badge>

          <h1 className="text-5xl font-black tracking-[-0.05em] text-foreground sm:text-6xl">
            강연자도, 지자체도,
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              MICE 기획사도.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-xl font-bold leading-9 text-foreground sm:text-2xl">
            누구든 이벤트를 엽니다.
          </p>

          <p className="mt-4 max-w-xl text-base leading-8 text-muted-foreground sm:text-lg">
            디자이너 없이 랜딩페이지, 개발자 없이 티켓 판매, 회계사 없이 정산까지.
            <br />
            AI와 함께 5분 안에 만들고, 당신은 행사에 집중하세요.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/login">
                5분 만에 시작하기
                <ChevronRight className="size-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              {/* 실제 이벤트는 팬이 예매하는 피켓에 있다 — 피켓 이벤트 목록을 새 탭으로 연다. */}
              <a href={marketEventsUrl()} target="_blank" rel="noopener noreferrer">
                실제 이벤트 보기
              </a>
            </Button>
          </div>

          <p className="mt-6 text-sm text-muted-foreground">
            신용카드 필요 없음 · 첫 이벤트 무료 · 판매되는 만큼만 수수료
          </p>
        </div>

        {/* 우측: 제품 목업 (이벤트 카드 + 대시보드 미니) */}
        <div className="relative hidden lg:col-span-5 lg:block">
          <div className="relative">
            {/* 뒤 대시보드 카드 */}
            <div className="absolute -right-6 top-12 w-64 rotate-3 rounded-2xl border border-border bg-card p-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">오늘 판매</p>
                  <p className="mt-1 text-2xl font-black tabular-nums text-foreground">
                    ₩ 3,240,000
                  </p>
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-success/10 text-success">
                  <BarChart3 className="size-5" />
                </div>
              </div>
              <div className="mt-4 flex h-14 items-end gap-1">
                {[40, 55, 45, 70, 60, 85, 72, 92, 80, 95, 88, 100].map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-sm bg-gradient-to-t from-primary/60 to-accent"
                    style={{ height: `${h}%` }}
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Users className="size-3" />
                  <span className="font-bold text-foreground">142</span>명 체크인
                </span>
                <span className="flex items-center gap-1 text-success">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                  </span>
                  LIVE
                </span>
              </div>
            </div>

            {/* 앞 이벤트 카드 */}
            <div className="relative -rotate-2 rounded-2xl border border-border bg-card shadow-2xl">
              <div className="relative h-40 overflow-hidden rounded-t-2xl bg-gradient-to-br from-primary via-accent to-primary">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.2),transparent_60%)]" />
                <Badge
                  variant="secondary"
                  className="absolute left-4 top-4 bg-white/90 text-xs font-bold text-primary backdrop-blur"
                >
                  컨퍼런스
                </Badge>
                <div className="absolute bottom-4 left-4">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-black/30 px-2.5 py-1 text-[10px] font-bold text-white backdrop-blur">
                    <Ticket className="size-3" />
                    얼리버드 판매 중
                  </div>
                </div>
              </div>
              <div className="p-5">
                <h3 className="text-base font-black leading-tight text-foreground">
                  2026 AI 컨퍼런스
                  <br />
                  in 판교
                </h3>
                <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                  <p className="flex items-center gap-1.5">
                    <Calendar className="size-3" />
                    2026년 5월 12일
                  </p>
                  <p className="flex items-center gap-1.5">
                    <MapPin className="size-3 text-primary" />
                    판교 테크노밸리 컨퍼런스홀
                  </p>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      얼리버드
                    </p>
                    <p className="text-lg font-black text-primary">₩ 120,000</p>
                  </div>
                  <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md">
                    <CreditCard className="size-4" />
                  </div>
                </div>
              </div>
            </div>

            {/* 플로팅 AI 뱃지 */}
            <div className="absolute -left-4 -top-4 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-lg">
              <div className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent">
                <Sparkles className="size-3 text-white" />
              </div>
              <span className="text-xs font-bold text-foreground">AI가 4분 22초에 완성</span>
            </div>

            {/* 플로팅 마켓 뱃지 */}
            <div className="absolute -bottom-3 right-4 flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-2 shadow-lg backdrop-blur">
              <Store className="size-4 text-success" />
              <span className="text-xs font-bold text-success">PICKKET 마켓 자동 노출</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
