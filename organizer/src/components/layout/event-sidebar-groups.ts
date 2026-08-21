/**
 * 이벤트 워크스페이스 사이드바 IA 정의 — **순수 데이터/로직만**.
 *
 * 렌더(`event-sidebar.tsx`)와 분리한 이유:
 *  ① `uiPreferencesStore` 가 기본 접힘 id 를 참조하는데, 컴포넌트에서 가져오면 순환 참조가 된다.
 *  ② 그룹 구성·게이트 필터를 React 없이 테스트할 수 있다(회귀 테스트가 여기에 붙는다).
 */
import {
  BarChart3, Building, CalendarDays, Clock, Code, FileText, Gauge, Gavel, Gift,
  HelpCircle, Inbox, LayoutDashboard, Mail, Music, Package, Palette, QrCode,
  Rocket, Send, Settings, Tag, Ticket, Upload, UserCheck, UserPlus, Users, Webhook,
} from "lucide-react";

export interface EventSidebarItem {
  label: string;
  icon: typeof LayoutDashboard;
  href: string;
  disabled?: boolean;
  tutorialId?: string;
  requiredFeature?: string;
  /** true 면 lottery 계열 sale_phase 가 있는 이벤트에서만 노출 */
  requiresLotteryPhase?: boolean;
  /** true 면 raffle_enabled 이벤트에서만 노출(F4 경품 추첨) */
  requiresRaffle?: boolean;
}

export interface EventSidebarGroup {
  /**
   * 접힘 상태 저장 키. **라벨과 분리된 안정 식별자**다.
   *
   * 예전엔 `group.label` 을 그대로 localStorage 키로 썼다. 그 탓에 라벨을 손대면
   * ① 사용자가 접어둔 상태가 전부 리셋되고 ② 사라진 그룹의 키가 영구 잔류했다.
   * id 는 표시 문구와 무관하게 고정하므로, 앞으로 라벨을 바꿔도 접힘이 보존된다.
   * **id 는 바꾸지 말 것** — 바꾸면 그 그룹의 접힘 상태가 초기화된다.
   */
  id: string;
  label: string;
  items: EventSidebarItem[];
}

/**
 * 워크스페이스 진입 항목 — 그룹 밖 최상단 고정.
 * `/events/{id}` 가 여기로 redirect 되는 진입점이라, 그룹 안에 묻히면 복귀 동선이 끊긴다.
 */
export const pinnedItem: EventSidebarItem = {
  label: "대시보드",
  icon: LayoutDashboard,
  href: "dashboard",
};

/**
 * 사이드바 IA — 5그룹 (2026-07-29 재편).
 *
 * ── 설계 기준 ──
 * 1. **상위는 시간축**(준비 → 판매 → 현장), 하위는 주제. 예전엔 시간축 그룹과 주제축
 *    그룹이 뒤섞여 "지금 뭘 하지"와 "그 기능 어디 있지" 둘 다 안 됐다.
 * 2. **그룹은 토글로 사라지지 않는다.** 모든 그룹이 게이트 없는 항목을 최소 2개 갖는다.
 *    예전 `고객 관리`(단체예약 1개)·`추가 도구`(전부 ticket_issuance)는 토글이 꺼지면
 *    그룹 헤더째 증발해, 이벤트마다 사이드바 골격이 달라져 위치 기억이 안 됐다.
 * 3. **물리 경로 불변** — 그룹/라벨/순서만 재정의한다(딥링크·북마크 보존).
 *
 * ── 별도 `디자인` 그룹을 만들지 않은 이유 ──
 * 제품이 이미 홈페이지 디자이너를 **준비 단계**로 못박아 뒀다:
 *   · `getting-started/page.tsx` 4스텝 중 3번째
 *   · `publish-check` 의 `대표 이미지`·`랜딩 카피` 2항목이 여기로 링크
 * 따로 빼면 온보딩 흐름과 어긋나므로 `준비` 안에 둔다.
 *
 * ── 용량 관리를 티켓에 흡수하지 않은 이유 ──
 * 저장소가 다르다. 티켓 등급 정원은 v2 `seat_tiers.capacity`(초과판매를 막는 정본)이고,
 * 용량 관리 화면은 v2 `capacity_assignments`(별도 테이블)를 쓴다. 흡수하면 등급 편집
 * 화면에 정원 입력이 둘 생겨 어느 쪽이 진짜인지 구분할 수 없게 된다 → `고급 설정` 존치.
 */
export const menuGroups: EventSidebarGroup[] = [
  {
    id: "prepare",
    label: "준비",
    items: [
      { label: "시작 가이드", icon: Rocket, href: "getting-started" },
      { label: "이벤트 설정", icon: Settings, href: "settings" },
      { label: "일정", icon: CalendarDays, href: "schedules" },
      { label: "티켓 & 좌석", icon: Ticket, href: "tickets", tutorialId: "event-sidebar-tickets" },
      { label: "티켓 디자이너", icon: Ticket, href: "ticket-designer" },
      { label: "부가상품", icon: Package, href: "products", tutorialId: "event-sidebar-products" },
      // questions: 등록 설문=판매 퍼널이라 디자인 → 이벤트 준비로 이동 (Phase2 슬림화)
      { label: "등록 질문", icon: HelpCircle, href: "questions", tutorialId: "event-sidebar-questions" },
      { label: "홈페이지 디자이너", icon: Palette, href: "homepage-designer", tutorialId: "event-sidebar-homepage" },
      // 행사 구성(출연진·시설)은 성격상 `일정`과 같은 세팅이라 준비로 흡수.
      // 예전 `행사 구성` 그룹은 두 항목 모두 토글이라 꺼지면 그룹째 사라졌다.
      { label: "출연진", icon: Music, href: "participants", requiredFeature: "participants" },
      { label: "시설 관리", icon: Building, href: "facilities", requiredFeature: "facilities" },
      // 게시 준비는 준비를 다 채운 뒤 누르는 관문 → 그룹 맨 끝.
      { label: "게시 준비", icon: Upload, href: "publish", tutorialId: "event-sidebar-publish" },
      // 기능 관리는 이벤트 설정(settings)의 FeatureToggles로 단일화됨 — 사이드바 항목 제거 (Phase2 슬림화)
    ],
  },
  {
    id: "sell",
    label: "판매·발권",
    items: [
      { label: "주문", icon: Package, href: "orders" },
      { label: "프로모코드", icon: Tag, href: "promo-codes" },
      { label: "어필리에이트", icon: Users, href: "affiliates" },
      { label: "대기열", icon: Clock, href: "waitlist" },
      { label: "리포트", icon: BarChart3, href: "reports" },
      { label: "응모 현황", icon: Gavel, href: "bids", requiresLotteryPhase: true },
      { label: "단체예약", icon: UserPlus, href: "group-bookings", requiredFeature: "group_booking" },
      // 발권 3종 인접 배치 — 유료 판매든 무료 초대든 "티켓을 손에 쥐여준다"는 같은 단계다.
      // b2b(F1/F4) 유지: 초대권 발송 파이프라인 진입점 — UI Phase2 슬림 대상 아님(UI base에 없던 항목)
      { label: "수동발권", icon: Ticket, href: "ticket-issuance", requiredFeature: "ticket_issuance" },
      { label: "대량 초대", icon: Send, href: "invitations", requiredFeature: "ticket_issuance" },
      { label: "초대권 편집", icon: Palette, href: "invitation-designer", requiredFeature: "ticket_issuance" },
    ],
  },
  {
    id: "onsite",
    label: "현장",
    items: [
      { label: "참석자", icon: UserCheck, href: "attendees" },
      { label: "체크인", icon: QrCode, href: "check-in" },
      { label: "경품 추첨", icon: Gift, href: "raffle", requiresRaffle: true },
    ],
  },
  {
    id: "comms",
    label: "소통",
    // 예전 `고객 문의`(2)·`발송`(2)·`공지·안내`(1) 3그룹을 통합. 5항목이면 한 그룹이 적정.
    // `이메일 캠페인`은 `메시지`의 부분집합(이메일 전용)이라 항목 제거 — campaigns 라우트는
    // 이미 messages 로 redirect 되어 있어(campaigns/page.tsx) 딥링크는 그대로 살아있다.
    items: [
      { label: "수신함", icon: Inbox, href: "inbox" },
      { label: "문의 (FAQ)", icon: HelpCircle, href: "inquiries" },
      { label: "메시지", icon: Mail, href: "messages" },
      { label: "공개 공지", icon: FileText, href: "open-notices" },
    ],
  },
  {
    id: "advanced",
    label: "고급 설정",
    items: [
      { label: "용량 관리", icon: Gauge, href: "capacity" },
      { label: "웹훅", icon: Webhook, href: "webhooks" },
      { label: "위젯", icon: Code, href: "widget" },
    ],
  },
  // 이동/보류 (Phase2 슬림화):
  // - rehearsal → 게시 준비(publish) 내 도구로 진입점 제공, 사이드바 독립 항목 제거
  // - compliance → 계정 설정 레벨로 이동, 이벤트 사이드바에서 제거
  // - packages → products "번들" 필터로 흡수, redirect 스텁만 존치
  // - bot-detection / final-call / bridge-page → 보류(카탈로그 숨김), v2 연결 시 카탈로그 복원
];

/** 그룹 id 목록 — 저장된 접힘 키 정리·테스트에서 참조. */
export const EVENT_SIDEBAR_GROUP_IDS = menuGroups.map((g) => g.id);

/**
 * 최초 방문 기본 접힘 그룹.
 *
 * 예전엔 `collapsedGroups: new Set()` 이라 **전 그룹이 펼쳐진 채** 시작해 30개 넘는 링크가
 * 한 번에 쏟아졌다. 사용 빈도가 낮은 두 그룹만 접어 초기 밀도를 낮춘다.
 *
 * ⚠️ **이벤트 상태(live 등)에 따라 동적으로 접지 않는다.** 주최자는 판매 시작 후에도
 *    가격·정원·소개를 계속 고치므로, 자동으로 접으면 매번 다시 펼쳐야 한다.
 *    접힘은 **사용자가 접었을 때만** 유지된다.
 */
export const DEFAULT_COLLAPSED_GROUP_IDS = ["comms", "advanced"] as const;

export interface EventSidebarGateInput {
  enabledFeatures?: string[];
  hasLotteryPhase?: boolean;
  raffleEnabled?: boolean;
}

/**
 * 기능 토글·판매모드 게이트를 적용해 실제 노출 그룹을 만든다.
 *
 * 항목이 0개가 된 그룹은 렌더하지 않는다(방어). 다만 현 IA 는 모든 그룹이 게이트 없는
 * 항목을 최소 2개 가지므로 **어떤 토글 조합에서도 그룹이 사라지지 않는다** — 이 불변식은
 * `event-sidebar-groups.test.ts` 가 강제한다.
 */
export function visibleGroupsFor(event: EventSidebarGateInput): EventSidebarGroup[] {
  return menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.requiresLotteryPhase && !event.hasLotteryPhase) return false;
        if (item.requiresRaffle && !event.raffleEnabled) return false;
        if (!item.requiredFeature) return true;
        return event.enabledFeatures?.includes(item.requiredFeature) ?? false;
      }),
    }))
    .filter((group) => group.items.length > 0);
}
