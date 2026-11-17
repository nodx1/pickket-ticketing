"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { usePathname } from "next/navigation";

const segmentLabels: Record<string, string> = {
  dashboard: "대시보드",
  events: "이벤트",
  create: "만들기",
  organizers: "주최자",
  notifications: "알림",
  account: "계정",
  settings: "설정",
  members: "팀 멤버",
  settlements: "정산",
  admin: "관리자",
  orders: "주문",
  attendees: "참석자",
  products: "상품",
  "promo-codes": "프로모코드",
  reports: "리포트",
  analytics: "분석",
  "homepage-designer": "홈페이지 디자인",
  "ticket-designer": "티켓 디자인",
  webhooks: "웹훅",
  publish: "발행",
  "seat-map": "좌석",
  waitlist: "대기열",
  schedules: "일정",
  questions: "등록 질문",
  "check-in": "체크인",
  overview: "현황",
  widget: "위젯",
  affiliates: "어필리에이트",
  bids: "응모 현황",
  "lottery-policy": "가중치 추첨 설정",
  fairness: "공정성 증명서",
  onsite: "현장 입장 관리",
  settlement: "정산 방식",
  "bot-detection": "봇탐지",
  "bridge-page": "브릿지페이지",
  campaigns: "이메일 캠페인",
  capacity: "용량 관리",
  compliance: "컴플라이언스",
  facilities: "시설 관리",
  "feature-manager": "기능 관리",
  "final-call": "파이널콜",
  "getting-started": "시작 가이드",
  "group-bookings": "단체예약",
  inbox: "수신함",
  inquiries: "문의 (FAQ)",
  marketing: "마케팅",
  messages: "메시지",
  "open-notices": "공개 공지",
  packages: "패키지",
  participants: "출연진",
  rehearsal: "리허설",
  "ticket-issuance": "수동발권",
  tickets: "티켓 & 좌석",
};

function isUuid(segment: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(segment);
}

export function Breadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length <= 1) {
    const label = segmentLabels[segments[0] ?? "dashboard"] ?? "대시보드";
    return <h1 className="text-lg font-semibold text-foreground">{label}</h1>;
  }

  const crumbs: Array<{ label: string; href: string }> = [];
  let path = "";

  for (const segment of segments) {
    path += `/${segment}`;
    if (isUuid(segment)) continue;
    const label = segmentLabels[segment] ?? segment;
    crumbs.push({ label, href: path });
  }

  return (
    <nav className="flex items-center gap-1.5 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.href} className="flex items-center gap-1.5">
            {index > 0 && <ChevronRight className="size-3.5 text-content-muted" />}
            {isLast ? (
              <span className="font-medium text-foreground">{crumb.label}</span>
            ) : (
              <Link href={crumb.href} className="text-content-subtle transition hover:text-foreground">
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
