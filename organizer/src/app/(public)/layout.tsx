import { PublicHeader } from "@/components/layout/public-header";
import { PublicFooter } from "@/components/layout/public-footer";

// per-request nonce CSP(proxy.ts) 는 동적 렌더 시에만 Next 프레임워크 인라인 스크립트에
// 주입된다. 정적 프리렌더 페이지(/terms·/privacy·/refund-policy·/about·/my-tickets)는
// 빌드타임 nonce 부재로 런타임 CSP nonce 와 불일치 → 인라인 스크립트 차단. 공개 그룹을
// 동적 렌더로 강제해 nonce 를 일관 주입한다(/e/[eventSlug] 등은 이미 동적이라 영향 없음).
export const dynamic = "force-dynamic";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <main>{children}</main>
      <PublicFooter />
    </div>
  );
}
