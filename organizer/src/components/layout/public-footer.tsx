"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mail, Ticket } from "lucide-react";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect width="20" height="20" x="2" y="2" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

export function PublicFooter() {
  // 법정 사업자 정보 — 브랜드(PICKKET.GO)와 별개인 운영 법인. env 로 환경별 오버라이드 가능.
  // ⚠️ Dockerfile 이 이 값들을 ARG→ENV(빈 문자열 포함)로 주입하므로 `??`(null/undefined 만
  // 폴백) 대신 `||`(빈 문자열도 폴백)를 써야 미설정 시 아래 기본값이 적용된다.
  const companyName = process.env.NEXT_PUBLIC_COMPANY_NAME || "주식회사 노드엑스";
  const ownerName = process.env.NEXT_PUBLIC_OWNER_NAME || "곽민철";
  // 법인정보 확정본 — 사업자등록증(851-81-04102) + 통신판매업신고증(제2026-고양덕양구-1811호, 2026-07-20 고양시 덕양구청 발급).
  const businessNumber = process.env.NEXT_PUBLIC_BUSINESS_NUMBER || "851-81-04102";
  const ecommerceNumber = process.env.NEXT_PUBLIC_ECOMMERCE_NUMBER || "통신판매업신고 제2026-고양덕양구-1811호";
  const contactPhone = process.env.NEXT_PUBLIC_CONTACT_PHONE || "070-8080-5606";
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL || "support@pickket.kr";
  const address =
    process.env.NEXT_PUBLIC_COMPANY_ADDRESS ||
    "경기도 고양시 덕양구 청초로 10, 덕은지엘메트로시티한강 A1동 1513호";

  // 이벤트 랜딩(/e/*)은 이벤트 중심 — 플랫폼 전체 사이트맵 대신 법정 사업자정보 + 필수 링크만.
  const pathname = usePathname();
  const compact = pathname?.startsWith("/e/") ?? false;

  if (compact) {
    return (
      <footer className="border-t border-border bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-8 lg:px-10">
          <div className="flex flex-col gap-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-bold text-foreground">{companyName}</p>
              <p className="mt-1">대표 {ownerName} · {businessNumber} · {ecommerceNumber}</p>
              <p>고객센터 {contactEmail} · {address}</p>
            </div>
            <nav className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
              <Link href="/terms" className="hover:text-foreground">이용약관</Link>
              <Link href="/privacy" className="hover:text-foreground">개인정보처리방침</Link>
              <Link href="/refund-policy" className="hover:text-foreground">환불정책</Link>
              <a href={`mailto:${contactEmail}`} className="hover:text-foreground">고객센터</a>
            </nav>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            © {new Date().getFullYear()} PICKKET.GO. All rights reserved.
          </p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="border-t border-border bg-card/50">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-12">
          {/* 좌측: 브랜드 + 소셜 + 상태 */}
          <div className="lg:col-span-4">
            <Link href="/" className="inline-flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent text-white shadow-md">
                <Ticket className="size-5" />
              </div>
              <span className="text-lg font-black tracking-tight text-foreground">PICKKET.GO</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
              이벤트를 여는 모든 사람을 위해. 만들고 · 팔고 · 운영하는 모든 것을 하나로.
            </p>

            {/* Status 뱃지 */}
            <Link
              href="https://status.pickket.kr"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/5 px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:border-success/60 hover:bg-success/10"
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              모든 시스템 정상
            </Link>

            {/* 소셜 */}
            <div className="mt-6 flex items-center gap-2">
              {[
                { icon: XIcon, href: "https://twitter.com/pickket_go", label: "X" },
                { icon: InstagramIcon, href: "https://instagram.com/pickket.go", label: "Instagram" },
                { icon: LinkedInIcon, href: "https://linkedin.com/company/pickket", label: "LinkedIn" },
                { icon: Mail, href: `mailto:${contactEmail}`, label: "Email" },
              ].map(({ icon: Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary hover:shadow-sm"
                >
                  <Icon className="size-4" />
                </a>
              ))}
            </div>
          </div>

          {/* 우측: 링크 4열 */}
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:col-span-8">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-foreground">제품</p>
              <nav className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <Link href="/#events" className="transition-colors hover:text-foreground">이벤트 찾기</Link>
                <Link href="/register" className="transition-colors hover:text-foreground">무료로 시작</Link>
                <Link href="/login" className="transition-colors hover:text-foreground">주최자 로그인</Link>
                <Link href="/about" className="transition-colors hover:text-foreground">서비스 소개</Link>
              </nav>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-foreground">구매자</p>
              <nav className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <Link href="/my-tickets" className="transition-colors hover:text-foreground">내 티켓 조회</Link>
                <Link href="/refund-policy" className="transition-colors hover:text-foreground">환불 정책</Link>
                <a href={`mailto:${contactEmail}`} className="transition-colors hover:text-foreground">고객센터</a>
              </nav>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-foreground">리소스</p>
              <nav className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <a href="https://status.pickket.kr" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">시스템 상태</a>
                <Link href="/sitemap.xml" className="transition-colors hover:text-foreground">사이트맵</Link>
              </nav>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-foreground">회사</p>
              <nav className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <Link href="/terms" className="transition-colors hover:text-foreground">이용약관</Link>
                <Link href="/privacy" className="transition-colors hover:text-foreground">개인정보처리방침</Link>
                <Link href="/refund-policy" className="transition-colors hover:text-foreground">환불 정책</Link>
              </nav>
            </div>
          </div>
        </div>

        {/* 하단: 사업자 정보 */}
        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-bold text-foreground">{companyName}</p>
            <p className="mt-1">
              대표 {ownerName} · 사업자등록번호 {businessNumber} · {ecommerceNumber}
            </p>
            <p>고객센터 {contactEmail} · {contactPhone} · {address}</p>
          </div>
          <p className="shrink-0">© {new Date().getFullYear()} PICKKET.GO. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
