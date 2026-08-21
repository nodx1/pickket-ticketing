import {
  BarChart3,
  CreditCard,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Concern {
  pain: string;
  solution: string;
}

interface Verb {
  number: string;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
  accent: "primary" | "accent" | "success";
  concerns: Concern[];
}

const verbs: Verb[] = [
  {
    number: "01",
    label: "만들다",
    icon: FileText,
    title: "AI에게 말하세요. 랜딩페이지가 완성됩니다.",
    description:
      '"12월 판교 AI 컨퍼런스, 300명, 유료 15만원" — 한 줄이면 됩니다. AI가 랜딩페이지, 상품, 일정, 좌석 배치까지 전부 세팅합니다.',
    accent: "primary",
    concerns: [
      {
        pain: "랜딩페이지 어떻게 만들지?",
        solution: "AI가 분야별 디자인으로 자동 생성",
      },
      {
        pain: "이벤트 양식이 너무 많아…",
        solution: "24가지 타입 템플릿 내장",
      },
      {
        pain: "디자이너 섭외할 돈 없는데…",
        solution: "5분이면 랜딩페이지 완성",
      },
    ],
  },
  {
    number: "02",
    label: "팔다",
    icon: CreditCard,
    title: "결제 붙이는 데 5분. 홍보하는 데 0원.",
    description:
      "토스 · 카카오 · 네이버 · 포트원 원클릭 연동. 만든 이벤트는 PICKKET 마켓에 자동 노출되어 수만 명에게 도달합니다.",
    accent: "accent",
    concerns: [
      {
        pain: "결제 붙이려면 개발자 필요해?",
        solution: "토스 · 카카오 · 네이버 원클릭 연동",
      },
      {
        pain: "무료 이벤트는 플랫폼 안 쓰는데…",
        solution: "무료 RSVP도 모두 지원",
      },
      {
        pain: "내 이벤트 아무도 모르면?",
        solution: "피켓 마켓 자동 노출 · 홍보비 0원",
      },
    ],
  },
  {
    number: "03",
    label: "운영하다",
    icon: BarChart3,
    title: "현장은 스마트폰 하나로. 정산은 자동으로.",
    description:
      "QR 체크인, 실시간 참석 현황, CRM 메시지 발송, 자동 정산 · 세금계산서까지. 행사 당일도, 끝난 후도 손대지 않아도 됩니다.",
    accent: "success",
    concerns: [
      {
        pain: "현장에서 입장 관리 어떻게?",
        solution: "모바일 QR 체크인 앱 내장",
      },
      {
        pain: "참석자 문의는 어디로?",
        solution: "메시지 · CRM 통합 관리",
      },
      {
        pain: "세금계산서 · 정산 골치 아파…",
        solution: "자동 발행 · 자동 정산",
      },
    ],
  },
];

const accentStyles = {
  primary: {
    text: "text-primary",
    border: "border-primary/20",
    bg: "bg-primary/5",
    iconBg: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  accent: {
    text: "text-accent",
    border: "border-accent/20",
    bg: "bg-accent/5",
    iconBg: "bg-accent/10 text-accent",
    dot: "bg-accent",
  },
  success: {
    text: "text-success",
    border: "border-success/20",
    bg: "bg-success/5",
    iconBg: "bg-success/10 text-success",
    dot: "bg-success",
  },
} as const;

export function ThreeVerbsSection() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
      {/* 헤더 */}
      <div className="mx-auto max-w-3xl text-center">
        <Badge variant="secondary" className="mb-5">
          HOW IT WORKS
        </Badge>
        <h2 className="text-4xl font-black tracking-[-0.04em] text-foreground sm:text-5xl">
          만들고, 팔고, 운영하세요.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
          기획자가 가장 자주 하는 고민, PICKKET.GO에서는 이미 해결돼 있습니다.
        </p>
      </div>

      {/* 3동사 카드 */}
      <div className="mt-16 space-y-8">
        {verbs.map((verb) => {
          const style = accentStyles[verb.accent];
          const Icon = verb.icon;
          return (
            <div
              key={verb.number}
              className={`overflow-hidden rounded-2xl border ${style.border} ${style.bg}`}
            >
              <div className="grid gap-8 p-8 lg:grid-cols-12 lg:p-12">
                {/* 좌측: 번호 + 제목 */}
                <div className="lg:col-span-5">
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex size-14 items-center justify-center rounded-2xl ${style.iconBg}`}
                    >
                      <Icon className="size-7" />
                    </div>
                    <span className={`text-5xl font-black tracking-tighter ${style.text}`}>
                      {verb.number}
                    </span>
                  </div>
                  <p className="mt-5 text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    STEP {verb.number}
                  </p>
                  <h3 className={`mt-1 text-3xl font-black ${style.text}`}>{verb.label}</h3>
                  <p className="mt-4 text-xl font-bold leading-9 tracking-[-0.02em] text-foreground sm:text-2xl">
                    {verb.title}
                  </p>
                  <p className="mt-4 text-base leading-7 text-muted-foreground">
                    {verb.description}
                  </p>
                </div>

                {/* 우측: Before → After 3카드 */}
                <div className="lg:col-span-7">
                  <p className="mb-4 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    자주 하는 고민
                  </p>
                  <div className="space-y-3">
                    {verb.concerns.map((concern) => (
                      <div
                        key={concern.pain}
                        className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-sm"
                      >
                        <div className="flex-1 text-sm font-medium text-muted-foreground line-through decoration-muted-foreground/40">
                          {concern.pain}
                        </div>
                        <div className={`hidden size-1.5 shrink-0 rounded-full sm:block ${style.dot}`} />
                        <div className="flex-1 text-sm font-bold text-foreground">
                          {concern.solution}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
