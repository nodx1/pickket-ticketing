import { Suspense } from "react";
import { PublicFooter } from "@/components/layout/public-footer";
import { AIDemoSection } from "./_components/ai-demo-section";

// 런타임 렌더링 강제 — EventDiscoveryGrid/SocialProofBar가 실시간 DB 값을 조회하며,
// 빌드 시점엔 DB가 없으므로 static prerender 불가.
export const dynamic = "force-dynamic";
import { EventDiscoveryGrid } from "./_components/event-discovery-grid";
import { HeroSection } from "./_components/hero-section";
import { OrganizerCTASection } from "./_components/organizer-cta-section";
import { PickketMarketSection } from "./_components/pickket-market-section";
import { SocialProofBar } from "./_components/social-proof-bar";
import { ThreeVerbsSection } from "./_components/three-verbs-section";
import { TrustStrip } from "./_components/trust-strip";
import { WhoUsesSection } from "./_components/who-uses-section";

export default function Home() {
  return (
    <main className="relative overflow-hidden">
      {/* 1. Hero — "강연자도, 지자체도, MICE 기획사도. 누구든 이벤트를 엽니다" */}
      <HeroSection />

      {/* 2. Trust Strip — 9개 핵심 가치 */}
      <div className="pb-4">
        <TrustStrip />
      </div>

      {/* 3. 누가 PICKKET.GO를 쓰나요? — 핵심 섹션 (8 페르소나 탭) */}
      <WhoUsesSection />

      {/* 4. Social Proof — 3동사 관점 숫자 */}
      <Suspense fallback={null}>
        <SocialProofBar />
      </Suspense>

      {/* 5. AI Demo — "한 문장이면 이벤트가 시작됩니다" */}
      <AIDemoSection />

      {/* 6. 3동사 섹션 — 만들다 · 팔다 · 운영하다 */}
      <ThreeVerbsSection />

      {/* 7. 진행 중인 이벤트 그리드 */}
      <Suspense
        fallback={
          <div className="py-20 text-center text-muted-foreground">
            이벤트를 불러오고 있습니다...
          </div>
        }
      >
        <EventDiscoveryGrid />
      </Suspense>

      {/* 8. PICKKET 마켓 연동 — "혼자 만들어도, 수만 명이 봅니다" */}
      <PickketMarketSection />

      {/* 9. Final CTA — "지금 바로 이벤트를 시작하세요" */}
      <OrganizerCTASection />

      {/* 10. Footer */}
      <PublicFooter />
    </main>
  );
}
