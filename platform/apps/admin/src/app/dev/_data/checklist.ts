export type ItemStatus = "done" | "wip" | "todo";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ItemStatus;
}

export interface ChecklistSection {
  id: string;
  title: string;
  items: ChecklistItem[];
}

export const checklist: ChecklistSection[] = [
  {
    id: "booking",
    title: "1. Core Booking Flow",
    items: [
      {
        id: "booking-1",
        label: "이벤트 생성 (Studio 6-step form)",
        status: "done",
      },
      {
        id: "booking-2",
        label: "이벤트 상세 페이지 (Consumer)",
        status: "done",
      },
      { id: "booking-3", label: "티어 선택 + 좌석 선택 UI", status: "done" },
      {
        id: "booking-4",
        label: "Venue ↔ Event 연결 워크플로우",
        status: "done",
      },
      { id: "booking-5", label: "결제 연동 (PortOne)", status: "wip" },
      { id: "booking-6", label: "주문 확정 + 티켓 발급", status: "wip" },
      { id: "booking-7", label: "주문 내역 / 티켓 조회", status: "wip" },
      { id: "booking-8", label: "취소 / 환불 처리", status: "wip" },
    ],
  },
  {
    id: "auth",
    title: "2. Auth & User",
    items: [
      { id: "auth-1", label: "회원가입 / 로그인 (JWT)", status: "done" },
      { id: "auth-2", label: "OAuth (카카오/네이버/구글)", status: "done" },
      { id: "auth-3", label: "본인인증 (PASS)", status: "wip" },
      { id: "auth-4", label: "마이페이지 프로필 수정", status: "wip" },
      { id: "auth-5", label: "비밀번호 재설정", status: "wip" },
      { id: "auth-6", label: "회원 탈퇴 (GDPR)", status: "wip" },
    ],
  },
  {
    id: "allocation",
    title: "3. Allocation Engine",
    items: [
      { id: "alloc-1", label: "공정 배분 알고리즘", status: "done" },
      { id: "alloc-2", label: "포인트 추첨 (lottery)", status: "done" },
      { id: "alloc-3", label: "팬 등급 가중치", status: "done" },
      { id: "alloc-4", label: "당첨 결과 발표 API", status: "done" },
      { id: "alloc-5", label: "투명성 리포트", status: "wip" },
      { id: "alloc-6", label: "대규모 부하 테스트", status: "todo" },
    ],
  },
  {
    id: "payment",
    title: "4. Payment",
    items: [
      { id: "pay-1", label: "PortOne 웹훅 엔드포인트", status: "done" },
      { id: "pay-2", label: "주문 스키마 + API", status: "done" },
      { id: "pay-3", label: "PG 실결제 연동 테스트", status: "todo" },
      { id: "pay-4", label: "결제 UI (Consumer)", status: "todo" },
      { id: "pay-5", label: "환불 처리 자동화", status: "todo" },
      { id: "pay-6", label: "정산 시스템", status: "todo" },
    ],
  },
  {
    id: "go",
    title: "5. Organizer Portal (Go)",
    items: [
      { id: "go-1", label: "이벤트 CRUD", status: "done" },
      { id: "go-2", label: "티어 관리", status: "done" },
      { id: "go-3", label: "대시보드 KPI", status: "wip" },
      { id: "go-4", label: "Analytics", status: "wip" },
      { id: "go-5", label: "참석자 관리", status: "todo" },
      { id: "go-6", label: "정산 조회", status: "todo" },
      { id: "go-7", label: "팀 관리", status: "todo" },
      { id: "go-8", label: "이벤트 페이지 빌더", status: "todo" },
    ],
  },
  {
    id: "admin",
    title: "6. Admin Panel",
    items: [
      { id: "admin-1", label: "이벤트 관리 (승인/반려)", status: "wip" },
      { id: "admin-2", label: "유저 관리 (밴/역할)", status: "done" },
      { id: "admin-3", label: "주문/환불 관리", status: "done" },
      { id: "admin-4", label: "재무 대시보드", status: "done" },
      { id: "admin-5", label: "감사 로그", status: "done" },
      { id: "admin-6", label: "Feature flags", status: "done" },
    ],
  },
  {
    id: "infra",
    title: "7. Infrastructure",
    items: [
      { id: "infra-1", label: "Docker Compose (dev)", status: "done" },
      { id: "infra-2", label: "CI/CD pipeline", status: "done" },
      { id: "infra-3", label: "DB migrations (Alembic)", status: "done" },
      { id: "infra-4", label: "AWS ECS 배포", status: "done" },
      { id: "infra-5", label: "도메인 + SSL", status: "done" },
      { id: "infra-6", label: "CDN (이미지/정적)", status: "done" },
      { id: "infra-7", label: "모니터링 대시보드", status: "done" },
      { id: "infra-8", label: "백업 + 복구 검증", status: "done" },
    ],
  },
  {
    id: "community",
    title: "8. Community & Social",
    items: [
      { id: "comm-1", label: "팬클럽 CRUD (Backend)", status: "done" },
      { id: "comm-2", label: "리뷰 시스템 (Backend)", status: "done" },
      { id: "comm-3", label: "퀘스트/뱃지 (Backend)", status: "done" },
      { id: "comm-4", label: "팬클럽 UI (Consumer)", status: "wip" },
      { id: "comm-5", label: "커뮤니티 UI", status: "wip" },
      { id: "comm-6", label: "알림 시스템 UI", status: "wip" },
    ],
  },
];
