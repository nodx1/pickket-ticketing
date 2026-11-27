"use client";

/**
 * 직원 입장 링크 — 현장 직원이 휴대폰으로 열면 바로 QR 입장 단말이 되는 링크를 만든다.
 *
 * 이벤트가 관리자 승인을 받아 열리면 만들 수 있고, 행사가 끝나고 12시간 뒤 자동으로 닫힌다(서버가 판단).
 * 링크 하나 = 「게이트 스캐너」 단말 하나다. 그래서 중지·폐기·새 링크는 아래 「현장 단말」 목록에서 그대로 한다.
 */
import { useState } from "react";
import { Link2, Smartphone } from "lucide-react";

import { gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/lib/hooks/useToast";
import { buildTerminalLink } from "@/lib/onsite/terminal-link";
import type { OnsiteOverview } from "@/lib/v2/gwasup-client";

import { TerminalLinkView } from "./terminal-link-view";

export function StaffLinkPanel({ eventId, overview, onChanged }: { eventId: string; overview: OnsiteOverview; onChanged: () => void }) {
  const { addToast } = useToast();
  const [gate, setGate] = useState("정문");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ link: string; label: string } | null>(null);
  const state = overview.entry_link ?? { open: false, reason: "입장 링크 상태를 불러오지 못했어요.", closes_at: null };
  const activeLinks = overview.terminals.filter((t) => t.kind === "gate_scanner" && t.status === "active").length;

  const create = async () => {
    const g = gate.trim() || "정문";
    const sameGate = overview.terminals.filter((t) => t.gate === g).length;
    const label = `${g} 휴대폰 ${sameGate + 1}`;
    setBusy(true);
    try {
      const res = await gw<{ key: string }>(eventId, "onsite/terminals", {
        method: "POST",
        json: { name: label, kind: "gate_scanner", gate: g, allowedTierIds: [] },
      });
      setIssued({ link: buildTerminalLink(window.location.origin, res.key), label });
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "입장 링크를 만들지 못했어요", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-primary/30 bg-card p-5" aria-labelledby="staff-link-title">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Smartphone className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="staff-link-title" className="text-lg font-bold text-foreground">
            직원 입장 링크
          </h2>
          <p className="mt-1 text-sm text-content-subtle">
            링크를 만들어 현장 직원에게 주면, 직원 휴대폰이 바로 입장 단말이 돼요. 카메라로 관객의 티켓 QR을 비추면 입장 여부가 크게 떠요.
          </p>
          {state.open ? (
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <label className="block space-y-1.5">
                <span className="block text-xs font-semibold text-content-subtle">게이트 이름</span>
                <input
                  value={gate}
                  onChange={(e) => setGate(e.target.value)}
                  maxLength={40}
                  placeholder="예: 정문, 2번 입구"
                  className="w-48 rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
              </label>
              <Button type="submit" disabled={busy}>
                <Link2 className="size-4" /> {busy ? "만드는 중…" : "입장 링크 만들기"}
              </Button>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button disabled aria-describedby="staff-link-reason">
                <Link2 className="size-4" /> 입장 링크 만들기
              </Button>
              <p id="staff-link-reason" className="text-sm text-content-subtle">
                {state.reason}
              </p>
            </div>
          )}
          {activeLinks ? (
            <p className="mt-3 text-xs text-content-subtle">
              지금 쓸 수 있는 링크 {activeLinks}개 — 아래 「현장 단말」에서 중지하거나 새 링크를 만들 수 있어요.
            </p>
          ) : null}
        </div>
      </div>

      <Dialog open={issued !== null} onOpenChange={(o) => (o ? null : setIssued(null))}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="size-5 text-primary" /> {issued?.label} 입장 링크
            </DialogTitle>
            <DialogDescription>창을 닫으면 이 링크는 다시 볼 수 없어요.</DialogDescription>
          </DialogHeader>
          {issued ? <TerminalLinkView link={issued.link} label={issued.label} closesAt={state.closes_at} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
