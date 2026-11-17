"use client";

/**
 * 입장 차단 · 계정 제재(Slash).
 *  - 티켓 차단/해제: 분실·도난·부정 의심 티켓. 저장 즉시 모든 단말에 차단 목록이 다시 내려간다.
 *  - 제재 목록: 자동 탐지(같은 기기 다중 계정 등)의 검토 표시와 부과·해제 이력. 해제도 새 기록으로 남는다.
 */
import { useState } from "react";
import { Ban, ShieldAlert, ShieldOff, Undo2 } from "lucide-react";

import { Pill, Section, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { formatDateTimeKst } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import type { OnsiteOverview, SanctionMonitor } from "@/lib/v2/gwasup-client";

export function BlockPanel({ eventId, overview, onChanged }: { eventId: string; overview: OnsiteOverview; onChanged: () => void }) {
  const { addToast } = useToast();
  const [ticket, setTicket] = useState("");
  const [reason, setReason] = useState("분실 신고");
  const [busy, setBusy] = useState(false);

  const setBlock = async (ticketNumber: string, block: boolean, why: string) => {
    setBusy(true);
    try {
      await gw(eventId, "onsite/blocks", { method: "POST", json: { ticketNumber, block, reason: why } });
      addToast({ message: block ? `${ticketNumber} 입장을 막았습니다` : `${ticketNumber} 차단을 풀었습니다`, variant: "success" });
      if (block) setTicket("");
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "처리하지 못했습니다", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const { blocked, sanctioned } = overview.blocklist;
  return (
    <Section title="입장 차단" description="막은 티켓은 모든 단말에서 즉시 거부됩니다. 제재 계정의 티켓도 자동으로 포함됩니다.">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ticket.trim()) void setBlock(ticket.trim().toUpperCase(), true, reason);
        }}
      >
        <input
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          placeholder="티켓번호 (TKT-…)"
          aria-label="차단할 티켓번호"
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="차단 사유"
          className="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <Button type="submit" size="sm" variant="danger" disabled={busy || !ticket.trim()}>
          <Ban className="size-4" /> 차단
        </Button>
      </form>
      <ul className="mt-4 space-y-2">
        {blocked.map((b) => (
          <li key={b.ticket_no} className="flex items-center justify-between gap-2 rounded-md bg-destructive/5 px-3 py-2 text-sm">
            <span className="font-mono text-foreground">{b.ticket_no}</span>
            <span className="flex-1 truncate text-xs text-content-subtle">{b.reason}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setBlock(b.ticket_no, false, "주최사 해제")}>
              <Undo2 className="size-4" /> 해제
            </Button>
          </li>
        ))}
        {sanctioned.map((n) => (
          <li key={n} className="flex items-center justify-between gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
            <span className="font-mono text-foreground">{n}</span>
            <span className="flex-1 truncate text-xs text-content-subtle">제재 계정 소유 티켓</span>
            <Pill tone="warning">자동</Pill>
          </li>
        ))}
        {blocked.length + sanctioned.length === 0 ? <li className="text-sm text-content-subtle">차단된 티켓이 없습니다.</li> : null}
      </ul>
    </Section>
  );
}

const ACTION_LABEL: Record<string, { label: string; tone: "danger" | "warning" | "default" }> = {
  impose: { label: "제재", tone: "danger" },
  flag: { label: "검토 필요", tone: "warning" },
  lift: { label: "해제", tone: "default" },
};

export function SanctionPanel({ eventId, data, onChanged }: { eventId: string; data: SanctionMonitor | null; onChanged: () => void }) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const lift = async (id: string) => {
    setBusy(id);
    try {
      await gw(eventId, `sanctions/${id}/lift`, { method: "POST", json: { note: "주최사 검토 후 해제" } });
      addToast({ message: "제재를 해제했습니다(기록은 남습니다)", variant: "success" });
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "해제하지 못했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="매크로·다중 계정 모니터링"
      description="같은 기기에서 여러 계정이 응모하면 3번째 계정부터 막고 검토 표시를 남깁니다. 제재된 계정은 AP가 소각되고 응모·입장이 제한됩니다."
    >
      {!data ? (
        <div className="h-24 animate-pulse rounded-md bg-bg-muted" />
      ) : data.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-content-subtle">
          <ShieldAlert className="size-4" /> 탐지된 계정이 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {data.items.slice(0, 30).map((s) => {
            const meta = ACTION_LABEL[s.action] ?? { label: s.action, tone: "default" as const };
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Pill tone={meta.tone}>{meta.label}</Pill>
                <span className="font-semibold text-foreground">{s.name}</span>
                <span className="text-xs text-content-subtle">{s.reason_label}</span>
                {s.action === "flag" && typeof s.evidence?.same_device_accounts === "number" ? (
                  <span className="text-xs text-content-subtle">같은 기기 {String(s.evidence.same_device_accounts)}계정</span>
                ) : null}
                {s.ap_burned ? <span className="text-xs text-destructive">AP {s.ap_burned.toLocaleString("ko-KR")} 소각</span> : null}
                <span className="ml-auto text-xs text-content-subtle">{s.created_at ? formatDateTimeKst(s.created_at) : ""}</span>
                {s.active && s.scope === "event" ? (
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => void lift(s.id)}>
                    <ShieldOff className="size-4" /> 해제
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
