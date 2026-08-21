import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Globe,
  Mail,
  MapPin,
  ScanLine,
  Sparkles,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const aiSteps = [
  { label: "이벤트 페이지 생성", time: "0:42" },
  { label: "티켓 3종 설정 (얼리버드 · 일반 · VIP)", time: "1:18" },
  { label: "등록 폼 자동 구성", time: "2:05" },
  { label: "세금계산서 · QR 체크인 활성화", time: "3:31" },
  { label: "PICKKET 마켓 자동 노출", time: "4:22" },
];

const tiers = [
  { name: "얼리버드", price: "120,000", dot: "bg-success", sold: 12, total: 70 },
  { name: "일반", price: "150,000", dot: "bg-primary", sold: 0, total: 200 },
  { name: "VIP", price: "250,000", dot: "bg-accent", sold: 0, total: 30 },
];

export function AIDemoSection() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
      {/* 헤더 */}
      <div className="mx-auto max-w-3xl text-center">
        <Badge variant="secondary" className="mb-5">
          <Sparkles className="mr-1.5 size-3" />
          AI-NATIVE
        </Badge>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground sm:text-4xl lg:text-5xl">
          한 문장이면,
          <span className="mt-2 block text-primary">이벤트가 시작됩니다.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
          AI에게 이벤트 정보를 말하면, 랜딩페이지부터 정산까지 전부 세팅합니다.
        </p>
      </div>

      {/* 채팅 ↔ 결과물 변환 */}
      <div className="mt-14 grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
        {/* 좌측: 채팅 */}
        <div className="lg:col-span-7">
          {/* 섹션 라벨 */}
          <div className="mb-4 flex h-6 items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <Bot className="size-3.5" />
              AI와의 대화
            </span>
            <span className="text-xs font-medium text-muted-foreground">2026. 04. 05 · 14:22</span>
          </div>

          <div className="space-y-5">
            {/* 사용자 메시지 */}
            <div className="flex flex-col items-end gap-1.5">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-5 py-4 text-primary-foreground shadow-sm">
                <p className="text-sm leading-7 sm:text-base">
                  12월 15일 판교 AI 컨퍼런스, 300명 규모, 유료 15만원, VIP 티켓 분리,
                  세금계산서 필요, QR 체크인해주세요
                </p>
              </div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <CheckCircle2 className="size-3 text-primary" />
                읽음 · 14:22
              </div>
            </div>

            {/* AI 응답 */}
            <div className="flex items-start gap-3">
              <div className="relative">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-white shadow-md">
                  <Bot className="size-5" />
                </div>
                {/* 온라인 표시 */}
                <span className="absolute -bottom-0.5 -right-0.5 flex size-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex size-3 rounded-full bg-success ring-2 ring-background" />
                </span>
              </div>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border bg-card px-5 py-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold text-foreground">PICKKET AI</p>
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">
                      Beta
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">14:26</span>
                </div>
                <p className="text-sm font-bold text-foreground sm:text-base">
                  준비가 끝났어요. 바로 판매를 시작할 수 있어요 ✨
                </p>
                <ul className="mt-4 space-y-2.5">
                  {aiSteps.map((step) => (
                    <li key={step.label} className="flex items-start gap-2.5 text-sm">
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                      <span className="flex-1 leading-6 text-foreground">{step.label}</span>
                      <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {step.time}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Sparkles className="size-3 text-primary" />
                    총 소요 시간 <span className="font-bold text-foreground">4분 22초</span>
                  </span>
                  <span className="inline-flex items-center gap-1 font-bold text-primary">
                    결과물 보기
                    <ArrowRight className="size-3" />
                  </span>
                </div>
              </div>
            </div>

            {/* 추가 사용자 메시지 */}
            <div className="flex flex-col items-end gap-1.5">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-5 py-4 text-primary-foreground shadow-sm">
                <p className="text-sm leading-7 sm:text-base">
                  참석자에게 보낼 초대 메일 템플릿도 만들어주세요. 리마인더랑 체크인 안내까지요.
                </p>
              </div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <CheckCircle2 className="size-3 text-primary" />
                읽음 · 14:27
              </div>
            </div>

            {/* 추가 AI 응답 */}
            <div className="flex items-start gap-3">
              <div className="relative">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-white shadow-md">
                  <Bot className="size-5" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 flex size-3">
                  <span className="relative inline-flex size-3 rounded-full bg-success ring-2 ring-background" />
                </span>
              </div>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border bg-card px-5 py-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold text-foreground">PICKKET AI</p>
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">
                      Beta
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">14:28</span>
                </div>
                <p className="text-sm font-bold text-foreground sm:text-base">
                  3가지 템플릿 준비했어요. 발송은 원클릭이에요.
                </p>
                <div className="mt-3 space-y-2">
                  {[
                    { icon: Mail, label: "참석 확정 안내", meta: "예매 직후 자동 발송" },
                    { icon: Bell, label: "D-1 리마인더", meta: "하루 전 오전 10시" },
                    { icon: ScanLine, label: "체크인 안내 · QR", meta: "당일 오전 7시" },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.label}
                        className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Icon className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-foreground">{item.label}</p>
                          <p className="text-[11px] text-muted-foreground">{item.meta}</p>
                        </div>
                        <CheckCircle2 className="size-4 shrink-0 text-success" />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
                  <span className="text-muted-foreground">
                    언제든 수정 가능 · 개인화 변수 자동 적용
                  </span>
                  <span className="inline-flex items-center gap-1 font-bold text-primary">
                    템플릿 편집
                    <ArrowRight className="size-3" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 우측: 생성된 이벤트 카드 프리뷰 */}
        <div className="lg:col-span-5">
          {/* 섹션 라벨 */}
          <div className="mb-4 flex h-6 items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em] text-success">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-success" />
              </span>
              자동 생성됨
            </span>
            <span className="text-xs font-medium text-muted-foreground">결과물</span>
          </div>

          {/* 이벤트 카드 */}
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
            {/* URL 바 */}
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
              <div className="flex gap-1">
                <span className="size-2 rounded-full bg-destructive" />
                <span className="size-2 rounded-full bg-warning" />
                <span className="size-2 rounded-full bg-success" />
              </div>
              <div className="ml-1 flex flex-1 items-center gap-1.5 truncate rounded-md bg-card px-2.5 py-1 text-[10px] font-medium text-muted-foreground sm:text-xs">
                <Globe className="size-3 shrink-0 text-success" />
                <span className="truncate">pickket.kr/e/ai-conf-pangyo-2026</span>
              </div>
            </div>

            {/* 히어로 이미지 */}
            <div className="relative h-36 bg-gradient-to-br from-primary via-accent to-primary">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.25),transparent_60%)]" />
              <div className="absolute left-4 top-4 flex items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className="bg-white/90 text-[10px] font-bold text-primary backdrop-blur"
                >
                  컨퍼런스
                </Badge>
                <Badge
                  variant="secondary"
                  className="bg-white/20 text-[10px] font-bold text-white backdrop-blur ring-1 ring-white/30"
                >
                  얼리버드
                </Badge>
              </div>
              <div className="absolute bottom-4 left-4 right-4">
                <h3 className="text-lg font-black leading-tight text-white drop-shadow-md sm:text-xl">
                  2026 AI 컨퍼런스 in 판교
                </h3>
              </div>
            </div>

            <div className="p-5">
              {/* 메타 */}
              <div className="space-y-1.5 text-xs text-muted-foreground sm:text-sm">
                <p className="flex items-center gap-2">
                  <Calendar className="size-3.5 shrink-0 text-primary" />
                  2026년 12월 15일 · 09:00
                </p>
                <p className="flex items-center gap-2">
                  <MapPin className="size-3.5 shrink-0 text-primary" />
                  판교 테크노밸리 컨퍼런스홀
                </p>
                <p className="flex items-center gap-2">
                  <Users className="size-3.5 shrink-0 text-primary" />
                  총 300석 · 세금계산서 · QR 체크인
                </p>
              </div>

              {/* 티켓 3종 */}
              <div className="mt-5 space-y-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <span>티켓</span>
                  <span>재고</span>
                </div>
                {tiers.map((t) => {
                  const remaining = t.total - t.sold;
                  const pct = (t.sold / t.total) * 100;
                  return (
                    <div
                      key={t.name}
                      className="rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <span className={`size-2 rounded-full ${t.dot}`} />
                          <span className="text-sm font-bold text-foreground">{t.name}</span>
                        </div>
                        <span className="text-sm font-black tabular-nums text-foreground">
                          ₩ {t.price}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${t.dot}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {remaining}/{t.total}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 푸터 */}
              <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                  </span>
                  <span className="text-xs font-bold text-success">판매 중</span>
                  <span className="text-xs text-muted-foreground">· 12장 판매</span>
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md">
                  <CreditCard className="size-4" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="mt-14 flex flex-col items-center gap-4">
        <Button size="lg" asChild>
          <Link href="/register">
            나도 5분 만에 만들어보기
            <ChevronRight className="size-4" />
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          무료로 시작 · 신용카드 필요 없음 · 판매되는 만큼만 수수료
        </p>
      </div>
    </section>
  );
}
