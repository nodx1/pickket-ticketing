"use client";

/**
 * 정산 방식 — 주최사 PG 직결(무경유) (과업 2-1 "입장권 발권 시 자금을 대행 수취하지 않고 주최사 PG 로
 * 직접 정산하는 무경유 오케스트레이션", 3-1 ② "결제 처리 Pull 구조 연동 모듈 · 감사 로그").
 *
 *  - 정산 방식: 피켓 수납 후 정산(기본) | 주최사 PG 직결
 *  - 주최사 토스 상점 키 등록 · 키 확인(토스 조회 API 실호출) — 시크릿은 암호화 저장, 화면엔 힌트만
 *  - 직결 주문 현황 · 플랫폼 수수료 청구액
 *  - PG 연동 원장(append-only 해시 체인) · 무결성 검증
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Building2, CheckCircle2, KeyRound, Landmark, Link2, RefreshCcw, ShieldCheck, ShieldX, Wallet } from "lucide-react";

import { HashText, PageHeader, Pill, Section, StatCard, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { formatDateTimeSecKst, formatKRW } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import { cn } from "@/lib/utils";
import type { SettlementOverview } from "@/lib/v2/gwasup-client";

const OP_LABEL: Record<string, string> = {
  confirm: "결제 승인",
  cancel: "결제 취소",
  pull_status: "상태 조회(Pull)",
  key_check: "키 확인",
};

export default function SettlementPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { addToast } = useToast();
  const [data, setData] = useState<SettlementOverview | null>(null);
  const [form, setForm] = useState({ label: "", clientKey: "", secretKey: "" });
  const [feeRate, setFeeRate] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; head?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await gw<SettlementOverview>(eventId, "settlement");
      setData(d);
      setFeeRate(Math.round(d.fee_rate * 1000) / 10);
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "불러오지 못했습니다", variant: "error" });
    }
  }, [addToast, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      addToast({ message: ok, variant: "success" });
      await load();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "처리하지 못했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="h-96 animate-pulse rounded-lg bg-bg-muted" />;
  const verified = data.accounts.filter((a) => a.status === "verified");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="고급 설정"
        title="정산 방식"
        description="주최사 PG 직결을 켜면 관객이 낸 대금이 피켓을 거치지 않고 주최사의 토스 상점으로 바로 들어갑니다. 피켓 수수료는 대금에서 떼지 않고 별도로 청구합니다."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCcw className="size-4" /> 새로고침
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-2">
        <ModeCard
          active={data.mode === "platform"}
          icon={Building2}
          title="피켓 수납 후 정산"
          body="피켓 상점으로 결제를 받고, 수수료를 뺀 금액을 정산일에 지급합니다. 기본값입니다."
          disabled={busy !== null || data.mode === "platform"}
          onClick={() => void run("mode", () => gw(eventId, "settlement", { method: "PUT", json: { mode: "platform" } }), "피켓 수납 정산으로 바꿨습니다")}
        />
        <ModeCard
          active={data.mode === "direct"}
          icon={Landmark}
          title="주최사 PG 직결 (무경유)"
          body="결제창·승인·취소·조회를 주최사 상점 키로 처리합니다. 정산 지급 대상에서 빠지고, 수수료는 청구서로 남습니다."
          disabled={busy !== null || verified.length === 0}
          note={verified.length === 0 ? "키 확인을 통과한 상점이 있어야 켤 수 있습니다" : undefined}
          onClick={() =>
            void run(
              "mode",
              () => gw(eventId, "settlement", { method: "PUT", json: { mode: "direct", pgAccountId: (data.account ?? verified[0]).id, feeRate: feeRate / 100 } }),
              "주최사 PG 직결을 켰습니다",
            )
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="현재 방식" value={data.mode === "direct" ? "PG 직결" : "피켓 수납"} icon={Wallet} tone="primary" />
        <StatCard label="직결 결제" value={`${data.direct_orders.toLocaleString("ko-KR")}건`} icon={CheckCircle2} tone="success" />
        <StatCard label="주최사 상점 입금" value={formatKRW(data.direct_gross)} icon={Landmark} />
        <StatCard label="피켓 수수료 청구" value={formatKRW(data.platform_fee_due)} hint={`수수료율 ${(data.fee_rate * 100).toFixed(1)}%`} icon={Building2} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="주최사 토스 상점 키" description="토스페이먼츠 상점관리자 → 개발자센터 → API 키에서 ‘API 개별 연동 키’를 붙여 넣으세요. 시크릿 키는 암호화해 저장하고 다시 보여 주지 않습니다.">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "register",
                async () => {
                  await gw(eventId, "settlement/pg-accounts", { method: "POST", json: form });
                  setForm({ label: "", clientKey: "", secretKey: "" });
                },
                "상점 키를 등록했습니다. ‘키 확인’을 눌러 주세요",
              );
            }}
          >
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="이름 (예: 본사 토스 상점)"
              aria-label="상점 이름"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
            <input
              value={form.clientKey}
              onChange={(e) => setForm({ ...form, clientKey: e.target.value })}
              placeholder="클라이언트 키 (test_ck_… / live_ck_…)"
              aria-label="클라이언트 키"
              className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
            />
            <input
              type="password"
              autoComplete="off"
              value={form.secretKey}
              onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
              placeholder="시크릿 키 (test_sk_… / live_sk_…)"
              aria-label="시크릿 키"
              className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" disabled={busy !== null || !form.clientKey || !form.secretKey}>
                <KeyRound className="size-4" /> 등록
              </Button>
              <label className="flex items-center gap-2 text-xs text-content-subtle">
                피켓 수수료율
                <input
                  type="number"
                  min={0}
                  max={30}
                  step={0.1}
                  value={feeRate}
                  onChange={(e) => setFeeRate(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
                  className="w-16 rounded border border-border bg-card px-1 text-right tabular-nums"
                />
                %
              </label>
            </div>
          </form>

          <ul className="mt-5 space-y-2">
            {data.accounts.map((a) => (
              <li key={a.id} className={cn("rounded-md border p-3", data.account?.id === a.id ? "border-primary bg-primary/5" : "border-border-subtle")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{a.label || "토스 상점"}</span>
                  <Pill tone={a.mode === "live" ? "danger" : "default"}>{a.mode === "live" ? "운영 키" : "테스트 키"}</Pill>
                  <Pill tone={a.status === "verified" ? "success" : a.status === "failed" ? "danger" : "warning"}>
                    {a.status === "verified" ? "확인됨" : a.status === "failed" ? "확인 실패" : "확인 전"}
                  </Pill>
                  {data.account?.id === a.id && data.mode === "direct" ? (
                    <Pill tone="primary">
                      <Link2 className="size-3" /> 이 이벤트에 연결
                    </Pill>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy !== null}
                    onClick={() => void run(`verify:${a.id}`, () => gw(eventId, `settlement/pg-accounts/${a.id}/verify`, { method: "POST", json: {} }), "키 확인을 마쳤습니다")}
                  >
                    {busy === `verify:${a.id}` ? "확인 중…" : "키 확인"}
                  </Button>
                </div>
                <p className="mt-1 font-mono text-xs text-content-subtle">
                  {a.client_key} · {a.secret_hint}
                </p>
                {a.last_error ? <p className="mt-1 text-xs text-destructive">토스 응답: {a.last_error}</p> : null}
                {a.verified_at ? <p className="mt-1 text-xs text-content-subtle">확인 {formatDateTimeSecKst(a.verified_at)}</p> : null}
              </li>
            ))}
            {data.accounts.length === 0 ? <li className="text-sm text-content-subtle">등록된 상점 키가 없습니다.</li> : null}
          </ul>
        </Section>

        <Section
          title="PG 연동 원장"
          description="토스와 주고받은 요청·응답이 수정·삭제할 수 없는 원장에 해시 체인으로 쌓입니다(개인정보·키는 가려서 저장)."
          actions={
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("chain");
                try {
                  setChain(await gw(eventId, "ledger/verify"));
                } catch (err) {
                  addToast({ message: err instanceof Error ? err.message : "검증하지 못했습니다", variant: "error" });
                } finally {
                  setBusy(null);
                }
              }}
            >
              <ShieldCheck className="size-4" /> 무결성 검증
            </Button>
          }
        >
          {chain ? (
            <div className={cn("mb-3 flex flex-wrap items-center gap-2 rounded-md p-3 text-sm", chain.ok ? "bg-success/10" : "bg-destructive/10")}>
              {chain.ok ? <ShieldCheck className="size-4 text-success" /> : <ShieldX className="size-4 text-destructive" />}
              <span className="font-semibold">{chain.ok ? "체인 정상" : "체인 불일치"}</span>
              <span className="text-content-subtle">{chain.checked.toLocaleString("ko-KR")}건 재계산</span>
              {chain.head ? <HashText value={chain.head} label="최신 해시" /> : null}
            </div>
          ) : null}
          <ul className="max-h-96 divide-y divide-border-subtle overflow-auto">
            {data.ledger.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                <Pill tone={l.status === "ok" ? "success" : "danger"}>{l.status === "ok" ? "성공" : "실패"}</Pill>
                <span className="font-semibold text-foreground">{OP_LABEL[l.operation] ?? l.operation}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-content-subtle">
                  {String(l.response?.result ?? l.response?.status ?? l.response?.error ?? "")}
                </span>
                <span className="shrink-0 text-xs text-content-subtle">
                  {l.latency_ms !== null ? `${l.latency_ms}ms · ` : ""}
                  {formatDateTimeSecKst(l.at)}
                </span>
              </li>
            ))}
            {data.ledger.length === 0 ? <li className="py-2 text-sm text-content-subtle">아직 기록이 없습니다.</li> : null}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  icon: Icon,
  title,
  body,
  note,
  disabled,
  onClick,
}: {
  active: boolean;
  icon: typeof Building2;
  title: string;
  body: string;
  note?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled && !active}
      onClick={onClick}
      className={cn(
        "rounded-lg border p-5 text-left transition disabled:cursor-not-allowed",
        active ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border bg-card hover:border-primary/40 disabled:opacity-60",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        {active ? <Pill tone="primary">사용 중</Pill> : null}
      </div>
      <p className="mt-3 font-bold text-foreground">{title}</p>
      <p className="mt-1 text-sm leading-6 text-content-subtle">{body}</p>
      {note ? <p className="mt-2 text-xs text-warning">{note}</p> : null}
    </button>
  );
}
