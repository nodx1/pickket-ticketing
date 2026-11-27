"use client";

/** 현장 단말 — 등록(키·입장 링크는 한 번만 보여 줌) · 새 링크 · 게이트/허용 등급 · 일시중지/재개/폐기. */
import { useState } from "react";
import { Copy, Link2, MonitorSmartphone, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Pill, Section, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTimeSecKst } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import { buildTerminalLink } from "@/lib/onsite/terminal-link";
import type { OnsiteOverview } from "@/lib/v2/gwasup-client";

import { TerminalLinkView } from "./terminal-link-view";

const KINDS = [
  { value: "gate_scanner", label: "게이트 스캐너" },
  { value: "kiosk", label: "키오스크" },
  { value: "pos", label: "POS(매표소)" },
];

export function TerminalPanel({ eventId, overview, onChanged }: { eventId: string; overview: OnsiteOverview; onChanged: () => void }) {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "gate_scanner", gate: "정문", tiers: [] as string[] });
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 「새 링크」 — 확인 단계(대상 단말) → 발급된 링크
  const [rekeyTarget, setRekeyTarget] = useState<{ id: string; name: string } | null>(null);
  const [rekeyed, setRekeyed] = useState<{ link: string; label: string } | null>(null);
  const closesAt = overview.entry_link?.closes_at ?? null;

  const rekey = async () => {
    if (!rekeyTarget) return;
    setBusy(true);
    try {
      const res = await gw<{ key: string }>(eventId, `onsite/terminals/${rekeyTarget.id}/key`, { method: "POST", json: {} });
      setRekeyed({ link: buildTerminalLink(window.location.origin, res.key), label: rekeyTarget.name });
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "새 링크를 만들지 못했어요", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    try {
      const res = await gw<{ key: string }>(eventId, "onsite/terminals", {
        method: "POST",
        json: { name: form.name, kind: form.kind, gate: form.gate, allowedTierIds: form.tiers },
      });
      setIssuedKey(res.key);
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "등록에 실패했습니다", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: string, patch: Record<string, unknown>, done: string) => {
    try {
      await gw(eventId, `onsite/terminals/${id}`, { method: "PATCH", json: patch });
      addToast({ message: done, variant: "success" });
      onChanged();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "변경에 실패했습니다", variant: "error" });
    }
  };

  return (
    <Section
      title="현장 단말"
      description="키오스크·POS·게이트 스캐너·직원 휴대폰을 등록하면 단말 전용 입장 링크(키)가 발급됩니다. 단말은 이 이벤트와 지정한 게이트에만 묶입니다."
      actions={
        <Button
          size="sm"
          onClick={() => {
            setIssuedKey(null);
            setForm({ name: "", kind: "gate_scanner", gate: "정문", tiers: [] });
            setOpen(true);
          }}
        >
          <Plus className="size-4" /> 단말 등록
        </Button>
      }
    >
      {overview.terminals.length === 0 ? (
        <p className="rounded-md bg-bg-muted p-6 text-center text-sm text-content-subtle">등록된 단말이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {overview.terminals.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className={`size-2.5 shrink-0 rounded-full ${t.online ? "bg-success" : "bg-bg-emphasis"}`} aria-label={t.online ? "연결됨" : "연결 안 됨"} />
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-semibold text-foreground">
                  {t.name} <span className="font-normal text-content-subtle">· {t.kind_label} · {t.gate}</span>
                </p>
                <p className="text-xs text-content-subtle">
                  {t.allowed_tiers.length ? `입장 가능: ${t.allowed_tiers.map((x) => x.name).join(", ")}` : "모든 등급 입장 가능"} · 키 {t.key_prefix}
                  {t.last_seen_at ? ` · 마지막 신호 ${formatDateTimeSecKst(t.last_seen_at)}` : ""}
                </p>
              </div>
              <Pill tone={t.status === "active" ? (t.online ? "success" : "default") : t.status === "suspended" ? "warning" : "danger"}>
                {t.status === "active" ? (t.online ? "연결됨" : "대기") : t.status === "suspended" ? "일시중지" : "폐기"}
              </Pill>
              {t.status === "active" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRekeyed(null);
                    setRekeyTarget({ id: t.id, name: t.name });
                  }}
                >
                  <Link2 className="size-4" /> 새 링크
                </Button>
              ) : null}
              {t.status === "active" ? (
                <Button size="sm" variant="ghost" onClick={() => void update(t.id, { status: "suspended" }, `${t.name} 일시중지`)}>
                  <Pause className="size-4" /> 중지
                </Button>
              ) : t.status === "suspended" ? (
                <Button size="sm" variant="ghost" onClick={() => void update(t.id, { status: "active" }, `${t.name} 재개`)}>
                  <Play className="size-4" /> 재개
                </Button>
              ) : null}
              {t.status !== "revoked" ? (
                <Button size="sm" variant="ghost" onClick={() => void update(t.id, { status: "revoked" }, `${t.name} 폐기 — 키가 더 이상 동작하지 않습니다`)}>
                  <Trash2 className="size-4" /> 폐기
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorSmartphone className="size-5 text-primary" /> 현장 단말 등록
            </DialogTitle>
            <DialogDescription>발급된 입장 링크와 키는 이 창에서 한 번만 보입니다.</DialogDescription>
          </DialogHeader>
          {issuedKey ? (
            <div className="space-y-4">
              <TerminalLinkView link={buildTerminalLink(window.location.origin, issuedKey)} label={form.name} closesAt={closesAt} />
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer text-xs font-semibold text-content-subtle">키를 직접 입력하는 단말(키오스크·POS)</summary>
                <p className="mt-2 break-all font-mono text-sm text-foreground">{issuedKey}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={async () => {
                    await navigator.clipboard.writeText(issuedKey).catch(() => undefined);
                    addToast({ message: "단말 키를 복사했습니다", variant: "success" });
                  }}
                >
                  <Copy className="size-4" /> 키 복사
                </Button>
              </details>
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="단말 이름">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="예: 정문 1번 게이트"
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="종류">
                  <select
                    value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value })}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="게이트">
                  <input
                    value={form.gate}
                    onChange={(e) => setForm({ ...form, gate: e.target.value })}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
                  />
                </Field>
              </div>
              <Field label="입장 가능 등급(선택 안 하면 전체)">
                <div className="flex flex-wrap gap-2">
                  {overview.tiers.map((tier) => {
                    const on = form.tiers.includes(tier.id);
                    return (
                      <button
                        key={tier.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setForm({ ...form, tiers: on ? form.tiers.filter((x) => x !== tier.id) : [...form.tiers, tier.id] })}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${on ? "border-primary bg-primary text-primary-foreground" : "border-border text-content-subtle"}`}
                      >
                        {tier.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Button className="w-full" onClick={() => void register()} disabled={busy || !form.name.trim()}>
                {busy ? "등록 중…" : "등록하고 입장 링크 발급"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={rekeyTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRekeyTarget(null);
            setRekeyed(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="size-5 text-primary" /> {rekeyTarget?.name} 새 입장 링크
            </DialogTitle>
            <DialogDescription>
              {rekeyed ? "창을 닫으면 이 링크는 다시 볼 수 없어요." : "새 링크를 만들면 지금 링크로 열어 둔 기기는 바로 끊겨요. 끊긴 기기는 새 링크로 다시 열면 돼요."}
            </DialogDescription>
          </DialogHeader>
          {rekeyed ? (
            <TerminalLinkView link={rekeyed.link} label={rekeyed.label} closesAt={closesAt} />
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRekeyTarget(null)}>
                그만두기
              </Button>
              <Button onClick={() => void rekey()} disabled={busy}>
                {busy ? "만드는 중…" : "새 링크 만들기"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-content-subtle">{label}</span>
      {children}
    </label>
  );
}
