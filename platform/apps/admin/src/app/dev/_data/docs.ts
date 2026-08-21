export type DocCategory =
  | "architecture"
  | "business"
  | "checklists"
  | "operations"
  | "guides"
  | "prototypes"
  | "archive"
  | "status"
  | "prompts"
  | "legal";

export interface DocEntry {
  cat: DocCategory;
  file: string;
  desc: string;
}

export const docs: DocEntry[] = [
  // Architecture
  { cat: "architecture", file: "API.md", desc: "API 엔드포인트 설계" },
  {
    cat: "architecture",
    file: "AP_POINT_POLICY.md",
    desc: "마일리지(AP) 포인트 정책",
  },
  {
    cat: "architecture",
    file: "LAUNCH_SCOPE_V1.md",
    desc: "V1 런칭 기능 범위",
  },
  {
    cat: "architecture",
    file: "ON_SITE_OPS_HUB.md",
    desc: "현장 운영 허브 설계",
  },
  {
    cat: "architecture",
    file: "PROJECT_CONTROL_CENTER.md",
    desc: "프로젝트 관제센터",
  },
  {
    cat: "architecture",
    file: "PUBLIC_SECTOR_PLAN.md",
    desc: "공공부문 확장 계획",
  },
  {
    cat: "architecture",
    file: "SALE_MODE_POLICY_2026-03-12.md",
    desc: "판매 모드 비즈니스 규칙",
  },
  {
    cat: "architecture",
    file: "community-first-roadmap.md",
    desc: "커뮤니티 우선 로드맵",
  },
  {
    cat: "architecture",
    file: "event-landing-page-strategy.md",
    desc: "이벤트 랜딩페이지 전략",
  },

  // Business
  {
    cat: "business",
    file: "MASTER_PLAN_2026-03-28.md",
    desc: "마스터 비즈니스 플랜",
  },
  {
    cat: "business",
    file: "LAUNCH_PLAN_2026-04-01.md",
    desc: "4/1 런칭 로드맵",
  },
  {
    cat: "business",
    file: "BETA_LIVE_FEATURES_2026-03-15.md",
    desc: "베타 라이브 기능 목록",
  },
  {
    cat: "business",
    file: "BETA_PAGE_INVENTORY_2026-03-15.md",
    desc: "베타 페이지 인벤토리",
  },
  {
    cat: "business",
    file: "FEATURE_INVENTORY_2026-03-12.md",
    desc: "전체 기능 인벤토리",
  },
  {
    cat: "business",
    file: "HANKYUNG_PARTNERSHIP_ANALYSIS.md",
    desc: "한경 파트너십 분석",
  },
  {
    cat: "business",
    file: "HANKYUNG_PRESENTATION.md",
    desc: "한경 프레젠테이션",
  },
  {
    cat: "business",
    file: "TICKETING_PLATFORM_AUDIT_2026-03-13.md",
    desc: "티켓 플랫폼 감사",
  },
  {
    cat: "business",
    file: "UI_UX_REVIEW_REPORT_2026-03-02.md",
    desc: "UI/UX 리뷰 리포트",
  },
  {
    cat: "business",
    file: "MYMUSICTASTE_BENCHMARK_2026-04-08.md",
    desc: "MyMusicTaste 벤치마크 (수요 집계 + MMTing)",
  },
  {
    cat: "business",
    file: "PODOAL_BENCHMARK_2026-04-08.md",
    desc: "포도알 벤치마크 (미션 루프 분석)",
  },
  {
    cat: "business",
    file: "COMPETITOR_DEEP_DIVE_2026-04-09.md",
    desc: "경쟁사 정밀 리서치 (DICE/Bandsintown/Laylo/Seatlab)",
  },
  {
    cat: "business",
    file: "LAYLO_DEEP_DIVE_2026-04-09.md",
    desc: "Laylo 심층 분석 (Drop 철학 + 사례)",
  },
  {
    cat: "business",
    file: "PICKKET_FAN_EXPERIENCE_SCENARIO_2026-04-09.md",
    desc: "팬 관점 Pickket 경험 시나리오",
  },

  // Checklists
  {
    cat: "checklists",
    file: "MASTER_PROJECT_CHECKLIST.md",
    desc: "마스터 프로젝트 체크리스트",
  },
  {
    cat: "checklists",
    file: "DEVELOPMENT_DETAILED_CHECKLIST.md",
    desc: "개발 상세 체크리스트",
  },
  {
    cat: "checklists",
    file: "AWS_PROD_READINESS_GATE.md",
    desc: "AWS 프로덕션 준비 게이트",
  },
  { cat: "checklists", file: "RELEASE_QA_GATE.md", desc: "릴리즈 QA 게이트" },

  // Operations
  { cat: "operations", file: "DEPLOYMENT.md", desc: "배포 가이드" },
  { cat: "operations", file: "INFRASTRUCTURE.md", desc: "인프라 구성" },
  { cat: "operations", file: "RUNBOOK.md", desc: "운영 런북" },
  {
    cat: "operations",
    file: "SECURITY_OPERATION_CHECKLIST.md",
    desc: "보안 운영 체크리스트",
  },
  {
    cat: "operations",
    file: "MONITORING_PLAYBOOK.md",
    desc: "모니터링 플레이북",
  },
  {
    cat: "operations",
    file: "ARCHITECTURE_UPGRADE.md",
    desc: "아키텍처 업그레이드 기록",
  },
  {
    cat: "operations",
    file: "CAPACITY_REPORT.md",
    desc: "용량 및 성능 리포트",
  },

  // Guides
  { cat: "guides", file: "CDN_SETUP.md", desc: "CDN 설정 가이드" },
  {
    cat: "guides",
    file: "ENVIRONMENT_MANAGEMENT_2026-03-15.md",
    desc: "환경 관리",
  },
  { cat: "guides", file: "MCP_TEAM_SETUP.md", desc: "MCP 팀 협업 셋업 가이드" },

  // Prototypes
  {
    cat: "prototypes",
    file: "DESIGN_GUIDE.md",
    desc: "디자인 가이드 (브랜드 철학 포함)",
  },
  {
    cat: "prototypes",
    file: "COMPONENT_MAPPING.md",
    desc: "프로토타입 → React 컴포넌트 매핑",
  },

  // Archive
  { cat: "archive", file: "AUDIT_SCORECARD.md", desc: "감사 스코어카드" },
  { cat: "archive", file: "DEVELOPMENT_NOTE.md", desc: "개발 노트" },
  {
    cat: "archive",
    file: "PM_EXEC_REPORT_2026-03-03.md",
    desc: "PM 실행 보고서",
  },

  // Status
  {
    cat: "status",
    file: "PROJECT_HEALTH_DASHBOARD.md",
    desc: "프로젝트 건강 대시보드",
  },
  { cat: "status", file: "README.md", desc: "상태 문서 안내" },
  {
    cat: "status",
    file: "2026-04-03-maturity-reaudit.md",
    desc: "04-03 성숙도 재감사 리포트",
  },
  {
    cat: "status",
    file: "2026-04-04-infra-hardening-report.md",
    desc: "04-04 인프라 강화 리포트",
  },
  {
    cat: "status",
    file: "staging-audit-2026-04-04.md",
    desc: "04-04 스테이징 감사",
  },

  // Prompts
  {
    cat: "prompts",
    file: "claude-session-prompt.md",
    desc: "Claude 세션 프롬프트",
  },
  { cat: "prompts", file: "codex-prompt.md", desc: "Codex 프롬프트" },
  { cat: "prompts", file: "stream-a-homepage.md", desc: "홈페이지 스트림" },
  {
    cat: "prompts",
    file: "stream-b-eventdetail.md",
    desc: "이벤트 상세 스트림",
  },

  // Legal
  { cat: "legal", file: "이용약관_Pickket.pdf", desc: "서비스 이용약관 (PDF)" },
  {
    cat: "legal",
    file: "개인정보처리방침_Pickket.pdf",
    desc: "개인정보 처리방침 (PDF)",
  },
  { cat: "legal", file: "환불정책_Pickket.pdf", desc: "환불 정책 (PDF)" },
  {
    cat: "legal",
    file: "청소년보호정책_Pickket.pdf",
    desc: "청소년 보호 정책 (PDF)",
  },
  {
    cat: "legal",
    file: "AP_포인트정책_Pickket.pdf",
    desc: "AP 포인트 정책 (PDF)",
  },
];

export const catStyle: Record<DocCategory, { bg: string; fg: string }> = {
  architecture: { bg: "rgba(0,209,255,.12)", fg: "#00d1ff" },
  business: { bg: "rgba(34,197,94,.12)", fg: "#22c55e" },
  checklists: { bg: "rgba(234,179,8,.12)", fg: "#eab308" },
  operations: { bg: "rgba(249,115,22,.12)", fg: "#f97316" },
  guides: { bg: "rgba(168,85,247,.12)", fg: "#a855f7" },
  prototypes: { bg: "rgba(236,72,153,.12)", fg: "#ec4899" },
  archive: { bg: "rgba(142,142,154,.12)", fg: "#8e8e9a" },
  status: { bg: "rgba(0,209,255,.12)", fg: "#00d1ff" },
  prompts: { bg: "rgba(142,142,154,.12)", fg: "#8e8e9a" },
  legal: { bg: "rgba(239,68,68,.12)", fg: "#ef4444" },
};
