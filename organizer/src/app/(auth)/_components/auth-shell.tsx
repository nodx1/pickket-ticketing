import type { ReactNode } from "react";
import { Bot, CreditCard, Megaphone, ScanLine, Ticket } from "lucide-react";
import { Card } from "@/components/ui/card";

interface AuthShellProps {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthShell({
  title,
  description,
  children,
  footer,
}: AuthShellProps) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(420px,46vw)]">
      <div className="flex items-center justify-center bg-background px-6 py-12 lg:px-10">
        <Card className="w-full max-w-xl rounded-xl border-border bg-card p-8 sm:p-10">
          <div className="mb-8">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
              pickket.go
            </p>
            <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] text-foreground">
              {title}
            </h1>
            <p className="mt-3 text-sm leading-6 text-content-subtle">{description}</p>
          </div>
          <div className="space-y-6">{children}</div>
          {footer ? <div className="mt-8 border-t border-border pt-6 text-sm text-content-subtle">{footer}</div> : null}
        </Card>
      </div>

      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-primary-700 via-primary to-primary-400 p-10 text-white lg:flex lg:flex-col lg:justify-center xl:p-14">
        {/* 노이즈 오버레이 */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgba(108,92,231,0.3),transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_80%,rgba(5,150,105,0.15),transparent_50%)]" />

        <div className="relative space-y-10">
          {/* 로고 */}
          <div className="flex justify-end">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-white/8 px-5 py-2.5 text-sm font-semibold backdrop-blur-xl">
              <Ticket className="size-4 text-white" />
              PICKKET.GO
            </div>
          </div>

          {/* 히어로 카피 */}
          <div className="text-right">
            <h2 className="text-[5.5rem] font-black tracking-[-0.06em] leading-[1.05]">
              이벤트의
              <br />
              모든 것,
              <span className="block text-white/90">하나로.</span>
            </h2>
            <p className="mt-6 text-lg leading-8 text-white/55">
              AI와 함께 만들고, AI로 운영하세요.
              <br />
              결제 · 체크인 · 정산까지 한 곳에서.
            </p>
          </div>

          {/* 기능 리스트 */}
          <div className="space-y-3">
            {[
              { Icon: Bot, text: "AI 채팅으로 5분 만에 이벤트 생성" },
              { Icon: Megaphone, text: "PICKKET 마켓 자동 노출 — 홍보비 0원" },
              { Icon: CreditCard, text: "카드 · 카카오페이 · 네이버페이 간편결제" },
              { Icon: ScanLine, text: "QR 체크인 · 실시간 현황 · 자동 정산" },
            ].map((item) => (
              <div
                key={item.text}
                className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-5 py-4 backdrop-blur-sm"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <item.Icon className="size-[18px] text-white/90" />
                </div>
                <span className="text-[13px] font-medium leading-5 text-white/80">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
