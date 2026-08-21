import { AccountComplianceClient } from "./_components/account-compliance-client";

// 컴플라이언스/감사 로그 — 이벤트 토글에서 계정 설정 레벨로 이동 (Phase2 슬림화).
// 감사 로그는 이벤트별 스코프라, 계정 레벨에서 이벤트를 선택해 해당 이벤트의 감사 추적으로 진입한다.
export default function AccountCompliancePage() {
  return <AccountComplianceClient />;
}
