"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";
import { resolveTicketUsability, ticketStatusLabel } from "@/lib/ticket/usability";

const schema = z.object({
  email: z.email("올바른 이메일 형식을 입력해주세요"),
  phone: z.string().min(10, "전화번호를 입력해주세요"),
});

interface TicketGroup {
  eventTitle: string;
  startsAt: string;
  venueName: string | null;
  tickets: Array<{
    ticketNumber: string;
    name: string;
    productName: string;
    status: string;
  }>;
}

/**
 * 티켓 페이지에서 튕겨온 이유별 안내.
 *
 * 🔴 옛 동작은 이유 없이 `/my-tickets` 로 307 했다. 링크 만료·초대권 회수·토큰 누락·
 *    다른 기기 열람이 전부 같은 화면으로 떨어져 고객은 "티켓이 사라졌다"로 읽었다.
 *    할 수 있는 행동(재발송 요청 / 본인확인 / 주최자 문의)을 명시한다.
 */
const BLOCKED_NOTICE: Record<string, { title: string; detail: string }> = {
  link_expired: {
    title: "티켓 링크가 만료되었거나 더 이상 사용할 수 없습니다",
    detail:
      "알림톡으로 받으신 링크는 일정 기간이 지나면 만료됩니다. 주최자에게 재발송을 요청하시거나, 아래에서 본인 확인 후 조회해주세요.",
  },
  ticket_unavailable: {
    title: "취소·양도되었거나 기간이 지난 티켓입니다",
    detail: "환불·양도된 티켓은 열람할 수 없습니다. 문의가 필요하시면 주최자에게 연락해주세요.",
  },
  verify_required: {
    title: "본인 확인이 필요합니다",
    detail: "티켓을 열려면 구매 시 입력하신 이메일과 전화번호로 확인이 필요합니다.",
  },
};

function BlockedNotice() {
  const sp = useSearchParams();
  const reason = sp.get("reason");
  const ticket = sp.get("ticket");
  const notice = reason ? BLOCKED_NOTICE[reason] : null;
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground"
    >
      <p className="font-semibold">{notice.title}</p>
      <p className="mt-1 text-muted-foreground">{notice.detail}</p>
      {ticket ? (
        <p className="mt-2 text-xs text-muted-foreground">티켓번호 {ticket}</p>
      ) : null}
    </div>
  );
}

export default function MyTicketsPage() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [groups, setGroups] = useState<TicketGroup[]>([]);
  const [verified, setVerified] = useState(false);

  // 마운트 시: 매직링크 검증으로 발급된 쿠키가 있으면 티켓 목록을 불러온다. (감사 P1-7)
  // setState 는 모두 await 이후에 호출 — effect 내 동기 setState(cascading render) 회피.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/public/my-tickets", { method: "GET" });
      if (res.ok) {
        const payload = (await res.json()) as { data?: TicketGroup[] };
        setGroups(payload.data ?? []);
        setVerified(true);
      }
      const params = new URLSearchParams(window.location.search);
      if (params.get("error") === "invalid_or_expired") {
        setError("조회 링크가 만료되었거나 올바르지 않습니다. 다시 요청해주세요.");
      }
    })();
  }, []);

  async function handleSearch() {
    const parsed = schema.safeParse({ email, phone });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    const response = await fetch("/api/public/my-tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, phone }),
    });

    const payload = (await response.json()) as { data?: { message?: string }; error?: string };
    if (!response.ok) {
      setError(payload.error ?? "조회에 실패했습니다");
      return;
    }

    // 매직링크 발송 — 이메일 확인 유도(즉시 티켓/쿠키 발급 안 함).
    setError(null);
    setSent(payload.data?.message ?? "입력하신 이메일로 조회 링크를 보냈습니다. 메일함을 확인해주세요.");
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-3xl font-black tracking-[-0.04em] text-foreground">내 티켓 조회</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 튕겨온 이유 안내 — useSearchParams 는 Suspense 경계가 필요하다(Next.js). */}
            <Suspense fallback={null}>
              <BlockedNotice />
            </Suspense>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ticket-email">이메일</Label>
                <Input id="ticket-email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ticket-phone">전화번호</Label>
                <Input id="ticket-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
              </div>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {sent ? (
              <p role="status" className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
                {sent}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              보안을 위해 티켓 조회 링크를 이메일로 보내드립니다. 메일함에서 링크를 눌러 확인하세요.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => void handleSearch()} disabled={Boolean(sent)}>
                {sent ? "메일 전송됨" : "조회 링크 받기"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {verified && groups.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              조회 결과가 없습니다
            </CardContent>
          </Card>
        ) : verified ? (
          groups.map((group) => (
            <Card key={`${group.eventTitle}-${group.startsAt}`}>
              <CardHeader>
                <CardTitle className="text-foreground">{group.eventTitle}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {formatDate(group.startsAt)} · {group.venueName ?? "장소 미정"}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {group.tickets.map((ticket) => (
                  <Link
                    key={ticket.ticketNumber}
                    href={`/tickets/${ticket.ticketNumber}`}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3"
                  >
                    <div>
                      <p className="font-medium text-foreground">{ticket.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{ticket.productName}</p>
                    </div>
                    {/*
                      🔴 원시 영문 상태값이 화면에 새고 있었다 (2026-08-01).
                         `checked_in` 이 아니면 `ticket.status` 를 **그대로** 찍어서
                         구매자에게 「cancelled」·「expired」 가 보였다.
                         오늘 아침 주문 목록에서 고친 것과 같은 계열이다.
                         라벨은 `lib/ticket/usability.ts` 한 곳에서만 만든다.
                    */}
                    <Badge
                      variant={
                        ticket.status === "checked_in"
                          ? "success"
                          : resolveTicketUsability(ticket.status).usable
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {ticket.status === "checked_in" ? "체크인" : ticketStatusLabel(ticket.status)}
                    </Badge>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))
        ) : null}
      </div>
    </div>
  );
}
