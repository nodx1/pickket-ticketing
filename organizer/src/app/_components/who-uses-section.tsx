"use client";

import { useState } from "react";
import {
  Building2,
  Handshake,
  Landmark,
  Mic,
  PartyPopper,
  Sparkles,
  Briefcase,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Persona {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  types: string[];
  quote: string;
  scale: string;
  highlights: string[];
}

const personas: Persona[] = [
  {
    id: "speaker",
    icon: Mic,
    title: "강연자 · 교육자",
    subtitle: "세미나 · 워크숍 · 강의 · 북토크",
    types: ["세미나", "강의", "북토크", "워크숍"],
    quote:
      "강연 50명 선착순으로 받고, 입금 확인하고, 명단 관리하고, 당일 입장 체크. 이제 전부 자동이에요.",
    scale: "30~300명",

    highlights: ["AI 랜딩페이지", "참석자 명단 자동", "QR 체크인"],
  },
  {
    id: "enterprise",
    icon: Building2,
    title: "기업 · 스타트업",
    subtitle: "컨퍼런스 · 제품 런칭 · B2B 팝업",
    types: ["컨퍼런스", "런칭", "팝업", "기업행사"],
    quote:
      "AI 컨퍼런스 300명, 세금계산서 필수, VIP 차별화, CRM 연동까지 — B2B 이벤트 전체가 하나에서 끝납니다.",
    scale: "100~1천 명",
    highlights: ["세금계산서 자동", "CRM 통합", "VIP 티켓 구성"],
  },
  {
    id: "gov",
    icon: Landmark,
    title: "지자체 · 공공기관",
    subtitle: "지역축제 · 주민행사 · 공공 설명회",
    types: ["지역축제", "주민행사", "설명회", "문화공연"],
    quote:
      "판교 푸드 페스티벌 3만 명 사전예약, 구청 정산 규정 맞추고, 시민 CRM까지 한 곳에서.",
    scale: "1천~10만 명",
    highlights: ["다중 관리자", "정산 리포트", "사전예약"],
  },
  {
    id: "creator",
    icon: Sparkles,
    title: "크리에이터 · 인플루언서",
    subtitle: "팬미팅 · 사인회 · 굿즈 판매",
    types: ["팬미팅", "사인회", "미팅", "굿즈"],
    quote:
      "팬미팅 100석 얼리버드 + VIP + 굿즈 판매까지. 인스타 링크만 올렸는데 10분 만에 매진.",
    scale: "20~500명",
    highlights: ["빠른 판매", "소셜 공유", "얼리버드"],
  },
  {
    id: "mice",
    icon: Briefcase,
    title: "MICE · 행사 기획사",
    subtitle: "박람회 · 국제 컨퍼런스 · 트레이드쇼",
    types: ["박람회", "트레이드쇼", "국제행사", "B2B"],
    quote:
      "국제 박람회 3일 연속, 방문증 · 세션별 티켓 · 동시통역 예약 — 월 고정비 0원으로.",
    scale: "500~1만 명",
    highlights: ["복잡한 티켓 구조", "대량 관리", "월 고정비 0원"],
  },
  {
    id: "festival",
    icon: PartyPopper,
    title: "축제 · 페스티벌 기획자",
    subtitle: "지역축제 · 음악 페스티벌 · 푸드 페어",
    types: ["페스티벌", "음악축제", "푸드페어", "마켓"],
    quote:
      "2일 야외 페스티벌, 구역별 입장권, 사전 + 현장 판매 동시, 우천 환불 자동까지.",
    scale: "1천~5만 명",
    highlights: ["구역별 좌석", "현장 판매", "자동 환불"],
  },
  {
    id: "community",
    icon: Handshake,
    title: "동호회 · 커뮤니티",
    subtitle: "오프라인 모임 · 독서 모임 · 취미 클래스",
    types: ["동호회", "독서모임", "취미", "밋업"],
    quote:
      "매달 독서 모임 20명, 카톡방에 링크만. 회비 미납자 자동 알림까지.",
    scale: "5~100명",
    highlights: ["반복 이벤트", "저렴한 수수료", "자동 알림"],
  },
];

export function WhoUsesSection() {
  const [activeId, setActiveId] = useState(personas[0].id);

  const active = personas.find((p) => p.id === activeId) ?? personas[0];
  const ActiveIcon = active.icon;

  return (
    <section id="who-uses" className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
      {/* 헤더 */}
      <div className="mx-auto max-w-3xl text-center">
        <Badge variant="secondary" className="mb-5">
          FOR EVERYONE
        </Badge>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground sm:text-4xl lg:text-5xl">
          이벤트 플랫폼이
          <span className="mt-2 block text-muted-foreground">
            당신을 위한 게 아니라고 느꼈다면.
          </span>
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
          50명 북토크부터 5만 명 페스티벌까지.
          <br className="hidden sm:inline" />
          유료 티켓부터 무료 RSVP까지. PICKKET.GO는 경계가 없습니다.
        </p>
      </div>

      {/* 페르소나 탭 전환 */}
      <div className="mt-14">
        {/* 탭 버튼 */}
        <div className="flex flex-wrap justify-center gap-2">
          {personas.map((persona) => {
            const Icon = persona.icon;
            const isActive = persona.id === activeId;
            return (
              <button
                key={persona.id}
                type="button"
                onClick={() => setActiveId(persona.id)}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-all ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                <Icon className="size-4" />
                {persona.title}
              </button>
            );
          })}
        </div>

        {/* 상세 패널 */}
        <div className="mt-10 rounded-2xl border border-border bg-card p-8 shadow-sm lg:p-12">
          <div className="grid gap-10 lg:grid-cols-5">
            {/* 좌측: 아이콘 + 타이틀 */}
            <div className="lg:col-span-2">
              <div className="inline-flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-accent/15 text-primary">
                <ActiveIcon className="size-8" />
              </div>
              <h3 className="mt-5 text-3xl font-black tracking-[-0.03em] text-foreground">
                {active.title}
              </h3>
              <p className="mt-2 text-base text-muted-foreground">{active.subtitle}</p>

              {/* 타입 배지 */}
              <div className="mt-5 flex flex-wrap gap-2">
                {active.types.map((type) => (
                  <span
                    key={type}
                    className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    #{type}
                  </span>
                ))}
              </div>
            </div>

            {/* 우측: 인용문 + 스펙 */}
            <div className="lg:col-span-3">
              <div className="rounded-xl border-l-4 border-primary bg-primary/5 p-6">
                <p className="text-base leading-8 text-foreground sm:text-lg">
                  &ldquo;{active.quote}&rdquo;
                </p>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-muted/50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    평균 규모
                  </p>
                  <p className="mt-1 whitespace-nowrap text-lg font-bold text-foreground">{active.scale}</p>
                </div>
                {active.highlights.map((highlight) => (
                  <div
                    key={highlight}
                    className="rounded-lg border border-border bg-muted/50 p-4"
                  >
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      핵심
                    </p>
                    <p className="mt-1 text-sm font-bold text-foreground">{highlight}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 마무리 문구 */}
      <div className="mt-12 text-center">
        <p className="text-lg font-semibold text-foreground">
          이 중 하나에 해당하시나요?
          <br className="sm:hidden" />
          <span className="sm:ml-2">아니면 이 중 어디에도 속하지 않으세요?</span>
        </p>
        <p className="mt-3 text-base text-muted-foreground">
          어느 쪽이든, PICKKET.GO는 당신을 위한 플랫폼입니다.
        </p>
      </div>
    </section>
  );
}
