/* ─── 투어 타입 정의 ─── */

export type StepAction =
  | { type: "click"; target: string }
  | { type: "input"; target: string; minLength?: number }
  | { type: "navigate"; path: string }
  | { type: "none" };

export type StepPosition = "top" | "bottom" | "left" | "right" | "center";

export interface TourStep {
  id: string;
  /** data-tutorial="xxx" 값 */
  target: string;
  title: string;
  description: string;
  position: StepPosition;
  action: StepAction;
  spotlightPadding?: number;
  celebrateOnComplete?: boolean;
  /** 이 너비(px) 미만이면 스텝 스킵 또는 대체 */
  minWidth?: number;
  /** 모바일에서 대체할 스텝 ID */
  mobileAlternative?: string;
}

export interface TourDefinition {
  id: string;
  name: string;
  steps: TourStep[];
}

/* ─── 1. 웰컴 투어 ─── */

const welcomeTour: TourDefinition = {
  id: "welcome",
  name: "PICKKET.GO에 오신 것을 환영합니다",
  steps: [
    {
      id: "welcome-hero",
      target: "welcome-screen",
      title: "PICKKET.GO에 오신 것을 환영합니다!",
      description:
        "이벤트를 만들고, 티켓을 판매하고, 현장을 관리하세요. 간단한 투어로 주요 기능을 안내해 드릴게요.",
      position: "center",
      action: { type: "none" },
    },
    {
      id: "welcome-features",
      target: "welcome-screen",
      title: "이런 것들이 가능해요",
      description:
        "빠른 이벤트 생성 · 홈페이지 디자인 · 간편결제 · QR 체크인 · 실시간 리포트까지, 올인원으로 운영하세요.",
      position: "center",
      action: { type: "none" },
    },
    {
      id: "welcome-start",
      target: "welcome-screen",
      title: "지금 시작해볼까요?",
      description:
        "다음 버튼을 누르면 대시보드를 둘러봅니다. 언제든 ESC로 건너뛸 수 있어요.",
      position: "center",
      action: { type: "none" },
      celebrateOnComplete: true,
    },
  ],
};

/* ─── 2. 대시보드 오버뷰 ─── */

const dashboardOverviewTour: TourDefinition = {
  id: "dashboard-overview",
  name: "대시보드 둘러보기",
  steps: [
    {
      id: "sidebar-nav",
      target: "sidebar-events",
      title: "이벤트 관리",
      description:
        "여기서 모든 이벤트를 확인하고 관리할 수 있어요. 생성, 수정, 삭제까지 한 곳에서.",
      position: "right",
      action: { type: "none" },
      minWidth: 1024,
      mobileAlternative: "sidebar-nav-mobile",
    },
    {
      id: "sidebar-nav-mobile",
      target: "mobile-menu-button",
      title: "메뉴 열기",
      description:
        "☰ 메뉴 버튼을 누르면 전체 네비게이션을 볼 수 있어요.",
      position: "bottom",
      action: { type: "click", target: "mobile-menu-button" },
      minWidth: 0,
    },
    {
      id: "search-bar",
      target: "header-search",
      title: "빠른 검색",
      description:
        "⌘K를 눌러 이벤트, 주문, 참석자를 빠르게 찾아보세요. 뭐든 검색할 수 있어요.",
      position: "bottom",
      action: { type: "none" },
    },
    {
      id: "notification-bell",
      target: "header-notifications",
      title: "알림 센터",
      description:
        "새 주문, 환불 요청, 매진 알림 등 중요한 소식을 놓치지 마세요.",
      position: "bottom",
      action: { type: "none" },
    },
    {
      id: "dashboard-cards",
      target: "dashboard-stats",
      title: "한눈에 보는 현황",
      description:
        "총 매출, 주문 수, 이벤트 수를 실시간으로 확인할 수 있어요.",
      position: "bottom",
      action: { type: "none" },
      celebrateOnComplete: true,
    },
  ],
};

/* ─── 3. 이벤트 생성 ─── */

const createEventTour: TourDefinition = {
  id: "create-event",
  name: "첫 이벤트 만들기",
  steps: [
    {
      id: "create-button",
      target: "create-event-button",
      title: "이벤트 만들기",
      description:
        "이 버튼을 클릭해서 첫 이벤트를 만들어 보세요.",
      position: "left",
      action: { type: "click", target: "create-event-button" },
      celebrateOnComplete: true,
    },
  ],
};

/* ─── 4. 이벤트 설정 ─── */

const eventSetupTour: TourDefinition = {
  id: "event-setup",
  name: "이벤트 설정 가이드",
  steps: [
    {
      id: "setup-products",
      target: "event-sidebar-products",
      title: "상품/티켓 추가",
      description:
        "이벤트에 판매할 상품(티켓)을 등록하세요. 가격, 수량, 설명을 설정할 수 있어요.",
      position: "right",
      action: { type: "click", target: "event-sidebar-products" },
      minWidth: 1024,
    },
    {
      id: "setup-homepage",
      target: "event-sidebar-homepage",
      title: "홈페이지 디자인",
      description:
        "이벤트 홈페이지를 커스터마이즈하세요. 템플릿, 커버 이미지, 색상을 바꿀 수 있어요.",
      position: "right",
      action: { type: "click", target: "event-sidebar-homepage" },
      minWidth: 1024,
    },
    {
      id: "setup-questions",
      target: "event-sidebar-questions",
      title: "참석자 질문 설정",
      description:
        "티켓 구매 시 참석자에게 받을 정보를 설정하세요. 이름, 연락처 외에 커스텀 질문도 가능해요.",
      position: "right",
      action: { type: "none" },
      minWidth: 1024,
    },
    {
      id: "setup-publish-checklist",
      target: "event-sidebar-publish",
      title: "게시 체크리스트",
      description:
        "게시 전 필수 항목을 체크하세요. 모두 완료되면 이벤트를 공개할 수 있어요.",
      position: "right",
      action: { type: "click", target: "event-sidebar-publish" },
      minWidth: 1024,
    },
    {
      id: "setup-done",
      target: "event-sidebar-publish",
      title: "준비 완료!",
      description:
        "이벤트 설정이 끝났어요. 게시하면 PICKKET 마켓에 자동으로 노출됩니다.",
      position: "right",
      action: { type: "none" },
      celebrateOnComplete: true,
      minWidth: 1024,
    },
  ],
};

/* ─── 5. 매출 리포트 가이드 ─── */

const metricsGuideTour: TourDefinition = {
  id: "metrics-guide",
  name: "매출 리포트 안내",
  steps: [
    {
      id: "metrics-revenue",
      target: "metrics-revenue-card",
      title: "총 매출",
      description:
        "이벤트의 전체 매출을 실시간으로 보여줘요. 순매출(수수료 차감 후)도 함께 확인하세요.",
      position: "bottom",
      action: { type: "none" },
    },
    {
      id: "metrics-orders",
      target: "metrics-orders-card",
      title: "주문 현황",
      description:
        "총 주문 수, 완료/취소/환불 비율을 한눈에. 이상 징후가 있으면 알림으로 알려드려요.",
      position: "bottom",
      action: { type: "none" },
    },
    {
      id: "metrics-attendees",
      target: "metrics-attendees-card",
      title: "참석자 통계",
      description:
        "등록/체크인/미참석 현황을 확인하세요. 체크인율이 낮다면 리마인더 메시지를 보내보세요.",
      position: "bottom",
      action: { type: "none" },
      celebrateOnComplete: true,
    },
  ],
};

/* ─── 투어 레지스트리 ─── */

export const TOURS: TourDefinition[] = [
  welcomeTour,
  dashboardOverviewTour,
  createEventTour,
  eventSetupTour,
  metricsGuideTour,
];

export const TOUR_MAP = new Map(TOURS.map((t) => [t.id, t]));

/** 투어 ID로 투어 정의를 가져옵니다 */
export function getTour(tourId: string): TourDefinition | undefined {
  return TOUR_MAP.get(tourId);
}

/** 현재 활성 스텝을 가져옵니다 */
export function getActiveStep(
  tourId: string,
  stepIndex: number,
): TourStep | undefined {
  const tour = TOUR_MAP.get(tourId);
  if (!tour) return undefined;
  return tour.steps[stepIndex];
}

/** 뷰포트 너비에 따라 유효한 스텝 목록을 필터링합니다 */
export function getVisibleSteps(
  tourId: string,
  viewportWidth: number,
): TourStep[] {
  const tour = TOUR_MAP.get(tourId);
  if (!tour) return [];

  return tour.steps.filter((step) => {
    if (step.minWidth === undefined) return true;
    if (step.minWidth === 0) return viewportWidth < 1024;
    return viewportWidth >= step.minWidth;
  });
}
