"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Ticket, Plus } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { listAdmissionDays } from "@/lib/admission-days";
import { ATTENDEE_STATUS_LABELS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { formatDateShortKst } from "@/lib/format";
import {
  clearDurableIdempotencyKey,
  getDurableIdempotencyKey,
} from "@/lib/client/idempotency";

interface IssuedTicket { id: string; ticketNumber: string; name: string; email: string | null; phone: string | null; status: string; createdAt: string; orderNumber: string; }
interface ProductOption { id: string; name: string; }

export default function TicketIssuancePage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [tickets, setTickets] = useState<IssuedTicket[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [admissionDay, setAdmissionDay] = useState("");
  const [event, setEvent] = useState<{ admissionMode: string; startsAt: string | null; endsAt: string | null } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const { addToast } = useToast();

  // F1: daypass 이벤트면 발권 시 대회 기간 내 입장 지정일을 선택한다.
  const isDaypass = event?.admissionMode === "daypass";
  const dayOptions = useMemo(
    () => (isDaypass ? listAdmissionDays(event?.startsAt, event?.endsAt) : []),
    [isDaypass, event?.startsAt, event?.endsAt],
  );

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: IssuedTicket[] }>(`/api/events/${eventId}/ticket-issuance`);
      if (res.success) setTickets(res.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  useEffect(() => {
    async function loadProducts() {
      try {
        const res = await fetchWithAuth<{ success: boolean; data: ProductOption[] }>(`/api/events/${eventId}/products`);
        if (res.success && res.data.length > 0) {
          setProducts(res.data);
          setSelectedProductId(res.data[0].id);
        }
      } catch { /* ignore */ }
    }
    void loadProducts();
  }, [eventId]);

  useEffect(() => {
    async function loadEvent() {
      try {
        const res = await fetchWithAuth<{ success: boolean; data: { admissionMode?: string | null; startsAt?: string | null; endsAt?: string | null } }>(`/api/events/${eventId}`);
        if (res.success) {
          setEvent({
            admissionMode: res.data.admissionMode ?? "single",
            startsAt: res.data.startsAt ?? null,
            endsAt: res.data.endsAt ?? null,
          });
        }
      } catch { /* ignore */ }
    }
    void loadEvent();
  }, [eventId]);

  const issue = async () => {
    if (!name.trim()) return;
    if (!selectedProductId) { addToast({ message: "상품을 선택해주세요.", variant: "error" }); return; }
    if (isDaypass && !admissionDay) { addToast({ message: "입장 지정일을 선택해주세요.", variant: "error" }); return; }
    setIssuing(true);
    try {
      const scope = `ticket-issuance:${eventId}`;
      const fingerprint = JSON.stringify({
        name,
        email,
        phone,
        selectedProductId,
        admissionDay: isDaypass ? admissionDay : null,
      });
      const idempotencyKey = getDurableIdempotencyKey(scope, fingerprint);
      const res = await fetchWithAuth<{ success: boolean; data: { ticketNumber: string; orderNumber: string } }>(`/api/events/${eventId}/ticket-issuance`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ name, email: email || undefined, phone: phone || undefined, productId: selectedProductId, memo: "관리자 수동발권", admissionDay: isDaypass ? admissionDay : undefined }),
      });
      if (res.success) {
        clearDurableIdempotencyKey(scope, idempotencyKey);
        addToast({ message: `티켓 ${res.data.ticketNumber} 발행 완료`, variant: "success" });
        setName(""); setEmail(""); setPhone(""); setAdmissionDay(""); fetch_();
      }
    } catch { addToast({ message: "발권에 실패했습니다.", variant: "error" }); }
    finally { setIssuing(false); }
  };

  return (
    <div className="space-y-6">
      <div><p className="text-sm text-muted-foreground">수동발권</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">수동발권</h2></div>
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold text-foreground">초대권 발행</h3>
        <div className="flex flex-wrap gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 *" className="flex-1 min-w-[120px] rounded-lg border border-border bg-card px-4 py-2.5 text-sm" />
          <input type="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일 (선택)" className="flex-1 min-w-[120px] rounded-lg border border-border bg-card px-4 py-2.5 text-sm" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="전화번호 (선택)" className="flex-1 min-w-[120px] rounded-lg border border-border bg-card px-4 py-2.5 text-sm" />
          <select
            value={selectedProductId}
            onChange={(e) => setSelectedProductId(e.target.value)}
            aria-label="발권할 상품 선택"
            className="min-w-[160px] rounded-lg border border-border bg-card px-4 py-2.5 text-sm"
          >
            {products.length === 0 && <option value="">상품 없음</option>}
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {isDaypass ? (
            <select
              value={admissionDay}
              onChange={(e) => setAdmissionDay(e.target.value)}
              className="min-w-[160px] rounded-lg border border-border bg-card px-4 py-2.5 text-sm"
              aria-label="입장 지정일"
            >
              <option value="">입장 지정일 선택 *</option>
              {dayOptions.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          ) : null}
          <Button type="button" onClick={issue} disabled={issuing || !name.trim() || !selectedProductId || (isDaypass && !admissionDay)}>
            <Plus className="size-4" /> {issuing ? "발권중..." : "발권"}
          </Button>
        </div>
        {isDaypass ? (
          <p className="mt-3 text-xs text-muted-foreground">
            이 이벤트는 지정일권(daypass) 입장 방식입니다. 대회 기간 중 참석자가 입장할 날짜를 선택해 발권하세요.
          </p>
        ) : null}
      </div>
      {loading ? <div className="animate-pulse rounded-lg border bg-card p-6"><div className="h-5 w-48 rounded bg-bg-muted" /></div> : tickets.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center"><Ticket className="mx-auto size-12 text-primary" /><h3 className="mt-4 text-lg font-bold">수동 발행된 티켓이 없습니다</h3></div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <table className="w-full"><thead><tr className="border-b border-border text-left text-xs text-content-muted">
            <th className="px-4 py-3">티켓번호</th><th className="px-4 py-3">이름</th><th className="px-4 py-3">이메일</th><th className="px-4 py-3">상태</th><th className="px-4 py-3">발행일</th>
          </tr></thead><tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 text-sm font-mono">{t.ticketNumber}</td>
                <td className="px-4 py-3 text-sm">{t.name}</td>
                <td className="px-4 py-3 text-sm text-content-muted">{t.email ?? "-"}</td>
                <td className="px-4 py-3"><span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs text-success">{ATTENDEE_STATUS_LABELS[t.status] ?? t.status}</span></td>
                <td className="px-4 py-3 text-xs text-content-muted">{formatDateShortKst(t.createdAt)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}
