import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { getEventSummary } from "@/lib/server/events";
import { getPool } from "@/lib/db/pool";
import { getTicketReadiness } from "@/lib/server/publish-readiness";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function GettingStartedPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");

  const [event, ticketReadiness] = await Promise.all([
    getEventSummary(eventId, session.accountId),
    // 게시 게이트(publish-check)와 동일 기준(seat_tiers + 배치도 발행)으로 "티켓" 스텝 판정 통일 (감사 P0-12).
    getTicketReadiness(getPool(), eventId, session.accountId),
  ]);
  if (!event) redirect("/events");

  const steps = [
    { label: "이벤트 생성됨", complete: true, href: `/events/${eventId}/settings` },
    { label: "티켓(좌석 등급) 추가 · 배치도 발행", complete: ticketReadiness.ticketStatus === "pass", href: `/events/${eventId}/tickets` },
    { label: "홈페이지 디자인", complete: Boolean((event as { homepageDesign?: unknown }).homepageDesign), href: `/events/${eventId}/homepage-designer` },
    { label: "이벤트 공개", complete: event.status === "live", href: `/events/${eventId}/publish` },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">시작 가이드</h2>
      <div className="grid gap-4">
        {steps.map((step) => (
          <Card key={step.label}>
            <CardHeader><CardTitle className={step.complete ? "text-success" : "text-foreground"}>{step.complete ? "완료" : "대기"} · {step.label}</CardTitle></CardHeader>
            <CardContent>
              <Button asChild variant="outline"><Link href={step.href}>열기</Link></Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
