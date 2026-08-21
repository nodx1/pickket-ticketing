import {
  ArrowRight,
  Eye,
  Layers,
  Megaphone,
  Search,
  Sparkles,
  Ticket,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const benefits = [
  {
    icon: Eye,
    title: "수만 명의 눈에 닿습니다",
    description:
      "PICKKET 마켓플레이스는 이벤트를 찾는 사람들이 모이는 곳. 별도 마케팅 없이 자연스럽게 발견됩니다.",
    accent: "primary",
  },
  {
    icon: Megaphone,
    title: "홍보비 0원, 추가 작업 0개",
    description:
      "이벤트를 만드는 순간 자동 노출. 페이스북 광고, 인스타 홍보, 블로그 포스팅 따로 안 해도 됩니다.",
    accent: "accent",
  },
  {
    icon: Zap,
    title: "예매 즉시, 대시보드 반영",
    description:
      "PICKKET에서 누가 예매했는지, 얼마나 팔렸는지 GO 대시보드에서 실시간으로 확인하세요.",
    accent: "success",
  },
] as const;

const benefitStyles = {
  primary: "bg-primary/10 text-primary",
  accent: "bg-accent/10 text-accent",
  success: "bg-success/10 text-success",
} as const;

export function PickketMarketSection() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/5 via-card to-success/5 p-8 backdrop-blur-sm lg:p-14">
        {/* 배경 장식 */}
        <div className="pointer-events-none absolute -right-32 -top-32 size-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-32 size-96 rounded-full bg-success/10 blur-3xl" />

        <div className="relative">
          {/* 헤더 */}
          <div className="max-w-3xl">
            <Badge variant="success" className="mb-5">
              <Sparkles className="mr-1.5 size-3" />
              PICKKET 생태계
            </Badge>
            <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground sm:text-4xl lg:text-5xl">
              혼자 만들어도,
              <span className="mt-2 block text-primary">수만 명이 봅니다.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
              PICKKET.GO에서 만든 이벤트는 PICKKET 마켓플레이스에 자동 노출됩니다.
              <br className="hidden sm:inline" />
              이벤트를 찾는 사람에게 가장 먼저 보여집니다. 별도 광고비 0원, 추가 작업 0개.
            </p>
          </div>

          {/* 마켓 핵심 가치 */}
          <div className="mt-10 grid grid-cols-1 gap-3 rounded-2xl border border-border bg-card/80 p-5 backdrop-blur-sm sm:grid-cols-3 sm:gap-6 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Layers className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-base font-black text-foreground">24가지 카테고리</p>
                <p className="truncate text-xs text-muted-foreground">모든 이벤트 타입 지원</p>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:border-l sm:border-border sm:pl-6">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Search className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-base font-black text-foreground">카테고리 · 지역 검색</p>
                <p className="truncate text-xs text-muted-foreground">이벤트 찾는 사람을 매칭</p>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:border-l sm:border-border sm:pl-6">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
                <Zap className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-base font-black text-foreground">실시간 자동 노출</p>
                <p className="truncate text-xs text-muted-foreground">등록 즉시 마켓 반영</p>
              </div>
            </div>
          </div>

          {/* 플로우 파이프라인 */}
          <div className="mt-12">
            <div className="relative grid gap-8 lg:grid-cols-3 lg:gap-4">
              {/* 연결선 (데스크탑만) */}
              <div
                className="pointer-events-none absolute left-1/6 right-1/6 top-14 hidden h-px lg:block"
                style={{
                  background:
                    "repeating-linear-gradient(to right, rgba(108,92,231,0.4) 0 6px, transparent 6px 12px)",
                }}
              />

              {/* Step 1 */}
              <div className="group relative flex flex-col">
                <div className="flex h-full flex-col rounded-2xl border border-primary/20 bg-card p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-white shadow-md shadow-primary/30">
                      <Sparkles className="size-5" />
                    </div>
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-primary/60">
                      01
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-black text-foreground">PICKKET.GO에서 생성</h3>
                  <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
                    AI에게 한 줄로 설명 → 5분 만에 랜딩페이지 · 상품 · 결제 완성
                  </p>
                  {/* 미니 미리보기 */}
                  <div className="mt-auto flex h-28 flex-col justify-center rounded-lg bg-muted/60 p-3 pt-4">
                    <div className="flex items-center gap-2">
                      <div className="size-2 rounded-full bg-primary" />
                      <div className="h-1.5 flex-1 rounded-full bg-primary/30" />
                    </div>
                    <div className="mt-3 h-1.5 w-3/4 rounded-full bg-muted-foreground/20" />
                    <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-muted-foreground/20" />
                    <div className="mt-1.5 h-1.5 w-2/3 rounded-full bg-muted-foreground/20" />
                  </div>
                </div>
                {/* 모바일 화살표 */}
                <div className="my-2 flex justify-center lg:hidden">
                  <ArrowRight className="size-5 rotate-90 text-muted-foreground" />
                </div>
              </div>

              {/* Step 2 */}
              <div className="group relative flex flex-col">
                <div className="flex h-full flex-col rounded-2xl border border-accent/20 bg-card p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-success text-white shadow-md shadow-accent/30">
                      <Search className="size-5" />
                    </div>
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-accent/60">
                      02
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-black text-foreground">PICKKET 마켓 자동 노출</h3>
                  <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
                    이벤트 찾는 사람들이 모이는 곳. 카테고리 · 지역 · 날짜로 발견됨
                  </p>
                  {/* 미니 미리보기 — 그리드 */}
                  <div className="mt-auto h-28 rounded-lg bg-muted/60 p-2.5">
                    <div className="grid h-full grid-cols-3 grid-rows-2 gap-1.5">
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <div
                          key={i}
                          className={`rounded ${
                            i === 1
                              ? "bg-gradient-to-br from-accent to-primary ring-2 ring-accent/40"
                              : "bg-muted-foreground/15"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="my-2 flex justify-center lg:hidden">
                  <ArrowRight className="size-5 rotate-90 text-muted-foreground" />
                </div>
              </div>

              {/* Step 3 */}
              <div className="group relative flex flex-col">
                <div className="flex h-full flex-col rounded-2xl border border-success/20 bg-card p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-success to-primary text-white shadow-md shadow-success/30">
                      <Ticket className="size-5" />
                    </div>
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-success/60">
                      03
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-black text-foreground">GO 대시보드 실시간</h3>
                  <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
                    예매 · 매출 · 참석자 전부 실시간 반영. 한 곳에서 완전 관리
                  </p>
                  {/* 미니 미리보기 — 바 차트 */}
                  <div className="mt-auto flex h-28 items-end gap-1 rounded-lg bg-muted/60 p-3">
                    {[30, 45, 40, 60, 55, 75, 68, 85, 92, 78, 95, 100].map((h, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-sm bg-gradient-to-t from-success to-primary"
                        style={{ height: `${h}%` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 혜택 카드 */}
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {benefits.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="group rounded-2xl border border-border bg-card p-7 transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-card-hover"
                >
                  <div
                    className={`flex size-12 items-center justify-center rounded-xl transition-transform group-hover:scale-110 group-hover:rotate-3 ${benefitStyles[item.accent]}`}
                  >
                    <Icon className="size-5" />
                  </div>
                  <h3 className="mt-5 text-lg font-black text-foreground">{item.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
