import Link from "next/link";
import {
  Bot,
  CalendarCheck2,
  CreditCard,
  Globe,
  Megaphone,
  ScanQrCode,
  Shield,
  Smartphone,
  Sparkles,
  Store,
  Ticket,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// 루트 layout 의 `title.template`("%s — PICKKET.GO")이 브랜드명을 붙인다.
// 🔴 여기에 브랜드명을 다시 쓰면 "… — PICKKET.GO — PICKKET.GO" 가 된다.
export const metadata = { title: "회사 소개" };

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-16">
      {/* 섹션 1: PICKKET 생태계 */}
      <div className="rounded-[40px] border border-border bg-card/95 p-8 lg:p-12">
        <p className="text-sm uppercase tracking-[0.2em] text-primary">pickket ecosystem</p>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-foreground">
          PICKKET 생태계
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-8 text-muted-foreground">
          PICKKET은 하나의 플랫폼, 두 개의 트랙으로 이벤트 산업을 혁신합니다.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Ticket className="size-5" />
              </div>
              <h2 className="text-xl font-bold text-foreground">PICKKET</h2>
            </div>
            <p className="mt-2 text-sm font-semibold text-primary">새로운 시대의 예매 플랫폼</p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              콘서트, 축제, 컨퍼런스, 전시회 — 원하는 이벤트를 찾고 안전하게 예매하세요.
              시대가 변했습니다. 새로운 예매 경험이 시작됩니다.
            </p>
          </div>
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Globe className="size-5" />
              </div>
              <h2 className="text-xl font-bold text-foreground">PICKKET.GO</h2>
            </div>
            <p className="mt-2 text-sm font-semibold text-accent">MICE 산업을 위한 AI SaaS</p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              한국 MICE 산업에 제대로 된 SaaS가 없었습니다. AI로 이벤트를 만들고, 결제를 처리하고,
              현장까지 — 올인원 운영 플랫폼.
            </p>
          </div>
        </div>
        <div className="mt-6 rounded-[24px] border border-border bg-muted p-5 text-center">
          <p className="text-sm font-semibold text-foreground">한몸, 투 트랙</p>
          <p className="mt-2 text-sm text-muted-foreground">
            GO에서 이벤트를 만들면 PICKKET 마켓에 자동 노출. 예매하면 GO 대시보드에서 자동 관리.
          </p>
        </div>
      </div>

      {/* 섹션 2: 이벤트를 찾는 분들께 */}
      <div className="rounded-[40px] border border-border bg-card/95 p-8 lg:p-12">
        <p className="text-sm uppercase tracking-[0.2em] text-primary">for attendees</p>
        <h2 className="mt-4 text-3xl font-black tracking-[-0.04em] text-foreground">
          이벤트를 찾는 분들께
        </h2>
        <div className="mt-8 grid gap-6 lg:grid-cols-4">
          {[
            { icon: Shield, title: "안전 결제", desc: "카드 · 카카오페이 · 네이버페이 보안 결제" },
            { icon: Smartphone, title: "즉시 발급", desc: "결제 완료 즉시 모바일 티켓 발급" },
            { icon: Zap, title: "간편 환불", desc: "명확한 환불 정책, 빠른 처리" },
            { icon: Store, title: "PICKKET 마켓", desc: "다양한 이벤트를 한곳에서 발견" },
          ].map((item) => (
            <div key={item.title} className="rounded-[24px] border border-border bg-muted p-5 text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <item.icon className="size-5" />
              </div>
              <h3 className="mt-3 text-sm font-bold text-foreground">{item.title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 섹션 3: 이벤트를 만드는 분들께 */}
      <div className="rounded-[40px] border border-border bg-card/95 p-8 lg:p-12">
        <p className="text-sm uppercase tracking-[0.2em] text-primary">for organizers</p>
        <h2 className="mt-4 text-3xl font-black tracking-[-0.04em] text-foreground">
          이벤트를 만드는 분들께
        </h2>
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: CalendarCheck2,
              title: "AI 이벤트 생성",
              desc: "채팅 한 마디로 이벤트 페이지 완성. 결제, 체크인, 정산까지 자동 설정.",
            },
            {
              icon: CreditCard,
              title: "올인원 운영",
              desc: "티켓 판매, 참석자 관리, 매출 리포트, 정산까지 하나의 대시보드에서.",
            },
            {
              icon: Megaphone,
              title: "PICKKET 마켓 자동 노출",
              desc: "이벤트를 만들면 PICKKET 마켓플레이스에 자동 노출. 별도 홍보비 0원.",
            },
          ].map((item) => (
            <div key={item.title} className="rounded-lg border border-border bg-muted p-6">
              <div className="flex size-12 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <item.icon className="size-6" />
              </div>
              <h3 className="mt-4 text-xl font-bold text-foreground">{item.title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 섹션 4: AI 네이티브 */}
      <div className="rounded-[40px] border border-border bg-card/95 p-8 lg:p-12">
        <p className="text-sm uppercase tracking-[0.2em] text-primary">ai native</p>
        <h2 className="mt-4 text-3xl font-black tracking-[-0.04em] text-foreground">
          AI 네이티브란?
        </h2>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground">
          PICKKET.GO는 처음부터 AI를 핵심에 두고 설계되었습니다. 도구가 아닌, 파트너로서의 AI.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-4">
          {[
            { icon: Bot, step: "1", title: "AI 채팅 생성", desc: "대화형으로 이벤트 기획" },
            { icon: Sparkles, step: "2", title: "AI 디자인", desc: "이벤트 페이지 자동 생성" },
            { icon: ScanQrCode, step: "3", title: "AI 운영", desc: "챗봇 · 체크인 · 현황 관리" },
            { icon: Megaphone, step: "4", title: "AI 마케팅", desc: "타겟 메시지 · 자동 홍보" },
          ].map((item) => (
            <div key={item.step} className="rounded-[24px] border border-border bg-muted p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {item.step}
                </span>
                <item.icon className="size-5 text-primary" />
              </div>
              <h3 className="mt-3 text-sm font-bold text-foreground">{item.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Button asChild size="lg">
          <Link href="/#events">이벤트 둘러보기</Link>
        </Button>
        <Button variant="outline" asChild size="lg">
          <Link href="/register">무료로 시작하기</Link>
        </Button>
      </div>
    </div>
  );
}
