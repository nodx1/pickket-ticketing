import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CreditCard,
  Gauge,
  LayoutDashboard,
  Mail,
  Package,
  Palette,
  PlusCircle,
  QrCode,
  Rocket,
  Search,
  Settings,
  Tag,
  Ticket,
  UserCheck,
  Users,
  Webhook,
} from "lucide-react";

export type CommandCategory = "이동" | "액션" | "검색";

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  icon: LucideIcon;
  keywords: string[];
  href?: string;
  action?: () => void;
  requiresEvent?: boolean;
}

function eventCommands(eventId: string): Command[] {
  return [
    {
      id: "ev-dashboard",
      label: "이벤트 대시보드",
      category: "이동",
      icon: LayoutDashboard,
      keywords: ["대시보드", "dashboard", "개요"],
      href: `/events/${eventId}/dashboard`,
    },
    {
      id: "ev-settings",
      label: "이벤트 설정",
      category: "이동",
      icon: Settings,
      keywords: ["설정", "settings"],
      href: `/events/${eventId}/settings`,
    },
    {
      id: "ev-products",
      label: "상품 관리",
      category: "이동",
      icon: Package,
      keywords: ["상품", "products", "티켓"],
      href: `/events/${eventId}/products`,
    },
    {
      id: "ev-orders",
      label: "주문 관리",
      category: "이동",
      icon: CreditCard,
      keywords: ["주문", "orders", "결제"],
      href: `/events/${eventId}/orders`,
    },
    {
      id: "ev-attendees",
      label: "참석자",
      category: "이동",
      icon: UserCheck,
      keywords: ["참석자", "attendees"],
      href: `/events/${eventId}/attendees`,
    },
    {
      id: "ev-checkin",
      label: "체크인",
      category: "이동",
      icon: QrCode,
      keywords: ["체크인", "checkin", "qr"],
      href: `/events/${eventId}/check-in`,
    },
    {
      id: "ev-messages",
      label: "메시지",
      category: "이동",
      icon: Mail,
      keywords: ["메시지", "messages", "이메일"],
      href: `/events/${eventId}/messages`,
    },
    {
      id: "ev-promo",
      label: "프로모코드",
      category: "이동",
      icon: Tag,
      keywords: ["프로모", "promo", "할인", "쿠폰"],
      href: `/events/${eventId}/promo-codes`,
    },
    {
      id: "ev-reports",
      label: "리포트",
      category: "이동",
      icon: BarChart3,
      keywords: ["리포트", "reports", "분석"],
      href: `/events/${eventId}/reports`,
    },
    {
      id: "ev-homepage",
      label: "홈페이지 디자이너",
      category: "이동",
      icon: Palette,
      keywords: ["홈페이지", "디자이너", "homepage"],
      href: `/events/${eventId}/homepage-designer`,
    },
    {
      id: "ev-ticket-designer",
      label: "티켓 디자이너",
      category: "이동",
      icon: Ticket,
      keywords: ["티켓", "디자이너"],
      href: `/events/${eventId}/ticket-designer`,
    },
    {
      id: "ev-questions",
      label: "등록 질문",
      category: "이동",
      icon: Rocket,
      keywords: ["질문", "questions", "등록"],
      href: `/events/${eventId}/questions`,
    },
    {
      id: "ev-capacity",
      label: "용량 관리",
      category: "이동",
      icon: Gauge,
      keywords: ["용량", "capacity"],
      href: `/events/${eventId}/capacity`,
    },
    {
      id: "ev-webhooks",
      label: "웹훅",
      category: "이동",
      icon: Webhook,
      keywords: ["웹훅", "webhook", "연동"],
      href: `/events/${eventId}/webhooks`,
    },
    {
      id: "ev-affiliates",
      label: "어필리에이트",
      category: "이동",
      icon: Users,
      keywords: ["어필리에이트", "affiliates", "제휴"],
      href: `/events/${eventId}/affiliates`,
    },
  ];
}

export function getCommands(currentEventId?: string): Command[] {
  const navigation: Command[] = [
    {
      id: "nav-dashboard",
      label: "대시보드",
      category: "이동",
      icon: LayoutDashboard,
      keywords: ["대시보드", "dashboard", "홈"],
      href: "/dashboard",
    },
    {
      id: "nav-events",
      label: "이벤트 목록",
      category: "이동",
      icon: Calendar,
      keywords: ["이벤트", "events", "목록"],
      href: "/events",
    },
    {
      id: "nav-organizers",
      label: "주최자 관리",
      category: "이동",
      icon: Building2,
      keywords: ["주최자", "organizers"],
      href: "/organizers",
    },
    {
      id: "nav-notifications",
      label: "알림",
      category: "이동",
      icon: Bell,
      keywords: ["알림", "notifications"],
      href: "/notifications",
    },
    {
      id: "nav-account",
      label: "계정설정",
      category: "이동",
      icon: Settings,
      keywords: ["계정", "설정", "account", "settings"],
      href: "/account",
    },
    {
      id: "nav-settlements",
      label: "정산",
      category: "이동",
      icon: CreditCard,
      keywords: ["정산", "settlements", "수익"],
      href: "/account/settlements",
    },
    {
      id: "nav-members",
      label: "팀 멤버",
      category: "이동",
      icon: Users,
      keywords: ["팀", "멤버", "members"],
      href: "/account/members",
    },
  ];

  const actions: Command[] = [
    {
      id: "act-create-event",
      label: "이벤트 만들기",
      category: "액션",
      icon: PlusCircle,
      keywords: ["만들기", "생성", "create", "new"],
      href: "/events/create",
    },
  ];

  const search: Command[] = [
    {
      id: "search-global",
      label: "통합 검색...",
      category: "검색",
      icon: Search,
      keywords: ["검색", "search", "찾기"],
    },
  ];

  return [...actions, ...navigation, ...(currentEventId ? eventCommands(currentEventId) : []), ...search];
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) {
    return commands;
  }

  const normalized = query.trim().toLowerCase();
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(normalized) ||
      command.keywords.some((keyword) => keyword.toLowerCase().includes(normalized)),
  );
}
