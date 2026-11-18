"use client";

/**
 * 추첨 결과 · 공정성 증명서 (과업 3-2 ① "Merkle 트리 기반 공정성 증명서 발행·조회").
 *
 * 등급(추첨 풀)마다:
 *  - 진행 순서: 정책 고정 → 시드 사전 커밋 → 응모 명단 Merkle 루트 → 추첨 → 결과 Merkle 루트 → 증명서
 *  - 무결성 값(시드 커밋·응모 루트·결과 루트) 복사
 *  - 결과 목록(이름·연락처 가림) + CSV
 *  - 증명서 발급(멱등) · 조회(서명·루트 실시간 대조) · PDF · 공개 검증 링크
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BadgeCheck, Download, ExternalLink, FileBadge2, FileText, RefreshCcw, ShieldCheck, ShieldX, Trophy } from "lucide-react";

import { HashText, PageHeader, Pill, Section, StatCard, Timeline, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTimeSecKst } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import type { CertificateView, FairnessPool, MaskedEntry } from "@/lib/v2/gwasup-client";

const ALGO_LABEL: Record<string, string> = {
  efraimidis_spirakis_weighted_sampling: "공정 추첨",
  weighted_lottery: "공정 추첨",
  weighted_allocation_v1: "가중 배분",
  weighted_allocation: "가중 배분",
};
const STATUS_LABEL: Record<string, { label: string; tone: "default" | "primary" | "success" | "warning" }> = {
  open: { label: "응모 중", tone: "primary" },
  closed: { label: "마감 · 추첨 대기", tone: "warning" },
  drawn: { label: "추첨 완료", tone: "success" },
};
const RESULT_LABEL: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  won: { label: "당첨", tone: "success" },
  waitlisted: { label: "대기", tone: "default" },
  pending: { label: "진행 중", tone: "warning" },
  excluded: { label: "제재 제외", tone: "danger" },
};
const CHECK_LABEL: Record<string, string> = {
  signature_valid: "전자서명 일치(Ed25519)",
  payload_hash_matches: "증명서 내용 해시 일치",
  entries_root_matches: "응모 Merkle 루트 = 현재 DB",
  results_root_matches: "결과 Merkle 루트 = 현재 DB",
  entries_root_before_draw: "응모 명단 고정이 추첨보다 먼저",
  commit_before_draw: "시드 커밋이 추첨보다 먼저",
};

export default function FairnessPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { addToast } = useToast();
  const [pools, setPools] = useState<FairnessPool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ pool: FairnessPool; entries: MaskedEntry[] } | null>(null);
  const [cert, setCert] = useState<CertificateView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gw<{ pools: FairnessPool[] }>(eventId, "fairness");
      setPools(data.pools);
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "불러오지 못했습니다", variant: "error" });
      setPools((p) => p ?? []);
    } finally {
      setLoading(false);
    }
  }, [addToast, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openResults = async (pool: FairnessPool) => {
    setBusy(`results:${pool.pool_id}`);
    try {
      const data = await gw<{ entries: MaskedEntry[] }>(eventId, `fairness/pools/${pool.pool_id}/results`);
      setResults({ pool, entries: data.entries });
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "결과를 불러오지 못했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const openCertificate = async (certNo: string) => {
    setBusy(`cert:${certNo}`);
    try {
      setCert(await gw<CertificateView>(eventId, `fairness/certificates/${certNo}`));
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "증명서를 불러오지 못했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const issue = async (pool: FairnessPool) => {
    setBusy(`issue:${pool.pool_id}`);
    try {
      const view = await gw<CertificateView>(eventId, `fairness/pools/${pool.pool_id}/certificate`, { method: "POST", json: {} });
      addToast({ message: `증명서 ${view.cert_no} 를 발급했습니다.`, variant: "success" });
      setCert(view);
      await load();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "발급에 실패했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  // 응모 마감 뒤 주최사가 바로 추첨한다. 운영에서는 자동 추첨 작업이 같은 일을 하고, 둘 중 먼저
  // 실행된 쪽만 추첨된다(v2 가 이중 추첨을 막는다).
  const drawNow = async (pool: FairnessPool) => {
    setBusy(`draw:${pool.pool_id}`);
    try {
      const r = await gw<{ already_drawn: boolean; winners?: number; waitlisted?: number }>(
        eventId,
        `fairness/pools/${pool.pool_id}/draw`,
        { method: "POST", json: {} },
      );
      addToast({
        message: r.already_drawn
          ? "이미 추첨이 끝났습니다."
          : `추첨을 마쳤습니다 — 당첨 ${r.winners ?? 0}명 · 대기 ${r.waitlisted ?? 0}명`,
        variant: "success",
      });
      await load();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "추첨에 실패했습니다", variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const drawn = pools?.filter((p) => p.status === "drawn").length ?? 0;
  const issued = pools?.filter((p) => p.certificate).length ?? 0;
  const applicants = pools?.reduce((a, p) => a + p.applicants, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="판매·발권"
        title="추첨 결과 · 공정성 증명서"
        description="추첨이 정해진 순서대로 진행됐는지, 결과가 나중에 바뀌지 않았는지를 해시와 전자서명으로 증명합니다. 증명서는 누구나 공개 페이지에서 직접 검증할 수 있습니다."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCcw className={loading ? "size-4 animate-spin" : "size-4"} /> 새로고침
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="추첨 등급" value={pools?.length ?? "-"} icon={FileText} />
        <StatCard label="총 응모" value={applicants.toLocaleString("ko-KR")} icon={Trophy} tone="primary" />
        <StatCard label="추첨 완료" value={drawn} icon={BadgeCheck} tone="success" />
        <StatCard label="증명서 발급" value={`${issued} / ${drawn}`} icon={FileBadge2} tone="primary" />
      </div>

      {pools === null ? (
        <div className="h-64 animate-pulse rounded-lg bg-bg-muted" />
      ) : pools.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <FileBadge2 className="mx-auto size-10 text-primary" />
          <p className="mt-3 font-semibold text-foreground">아직 추첨 응모가 없습니다</p>
          <p className="mt-1 text-sm text-content-subtle">공정 추첨 등급에 첫 응모가 들어오면 여기에 진행 상황이 나타납니다.</p>
        </div>
      ) : (
        <div className="grid gap-6 2xl:grid-cols-2">
          {pools.map((pool) => {
            const status = STATUS_LABEL[pool.status] ?? { label: pool.status, tone: "default" as const };
            return (
              <Section
                key={pool.pool_id}
                title={pool.tier_name || "등급"}
                description={`응모 ${pool.applicants.toLocaleString("ko-KR")}명 · 좌석 ${pool.capacity.toLocaleString("ko-KR")}석 · ${ALGO_LABEL[pool.algorithm] ?? pool.algorithm}`}
                actions={<Pill tone={status.tone}>{status.label}</Pill>}
              >
                <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                  <Timeline
                    format={formatDateTimeSecKst}
                    steps={[
                      { label: "가중치 정책 고정", at: pool.timeline.policy_locked_at },
                      { label: "추첨 시드 사전 커밋", at: pool.timeline.seed_committed_at },
                      { label: "응모 명단 루트 확정", at: pool.timeline.entries_root_at },
                      { label: "추첨 · 시드 공개", at: pool.timeline.drawn_at },
                      { label: "결과 루트 확정", at: pool.timeline.results_root_at },
                      { label: "증명서 발급", at: pool.timeline.certificate_issued_at },
                    ]}
                  />
                  <div className="space-y-3">
                    <HashRow label="정책 해시" value={pool.policy_hash} />
                    <HashRow label="시드 커밋" value={pool.seed_commitment} />
                    <HashRow label="응모 Merkle 루트" value={pool.entries_root} />
                    <HashRow label="결과 Merkle 루트" value={pool.results_root} />
                    {pool.closes_at ? (
                      <p className="text-xs text-content-subtle">
                        응모 마감 {formatDateTimeSecKst(pool.closes_at)}
                        {pool.status !== "drawn" && !pool.can_draw ? " · 마감 뒤 추첨할 수 있습니다" : ""}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-2">
                      {pool.can_draw ? (
                        <Button size="sm" onClick={() => void drawNow(pool)} disabled={busy !== null}>
                          <Trophy className="size-4" /> {busy === `draw:${pool.pool_id}` ? "추첨 중…" : "지금 추첨하기"}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="secondary" onClick={() => void openResults(pool)} disabled={busy !== null}>
                        <Trophy className="size-4" /> 결과 보기
                      </Button>
                      {pool.certificate ? (
                        <Button size="sm" onClick={() => void openCertificate(pool.certificate!.cert_no)} disabled={busy !== null}>
                          <FileBadge2 className="size-4" /> 증명서 {pool.certificate.cert_no}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => void issue(pool)}
                          disabled={busy !== null || pool.status !== "drawn" || !pool.results_root}
                          title={pool.status !== "drawn" ? "추첨이 끝나야 발급할 수 있습니다" : undefined}
                        >
                          <FileBadge2 className="size-4" /> {busy === `issue:${pool.pool_id}` ? "발급 중…" : "증명서 발급"}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Section>
            );
          })}
        </div>
      )}

      {/* 결과 목록 */}
      <Dialog open={results !== null} onOpenChange={(open) => !open && setResults(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{results?.pool.tier_name} 추첨 결과</DialogTitle>
            <DialogDescription>이름과 연락처는 가려서 보여 줍니다. 가중치는 응모 마감 때 Merkle 루트에 고정된 값입니다.</DialogDescription>
          </DialogHeader>
          {results ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {Object.entries(
                  results.entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.result]: (acc[e.result] ?? 0) + 1 }), {}),
                ).map(([k, n]) => (
                  <Pill key={k} tone={RESULT_LABEL[k]?.tone ?? "default"}>
                    {RESULT_LABEL[k]?.label ?? k} {n}
                  </Pill>
                ))}
                <a
                  className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                  href={`/api/events/${eventId}/gwasup/fairness/pools/${results.pool.pool_id}/results?format=csv`}
                >
                  <Download className="size-4" /> CSV 내려받기
                </a>
              </div>
              <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-bg-muted text-xs text-content-subtle">
                    <tr>
                      <th className="px-3 py-2 text-left">이름</th>
                      <th className="px-3 py-2 text-left">연락처</th>
                      <th className="px-3 py-2 text-left">결과</th>
                      <th className="px-3 py-2 text-right">투입 AP</th>
                      <th className="px-3 py-2 text-right">가중치</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.entries.map((e) => (
                      <tr key={e.entry_id} className="border-t border-border-subtle">
                        <td className="px-3 py-2">{e.name}</td>
                        <td className="px-3 py-2 font-mono text-xs">{e.phone}</td>
                        <td className="px-3 py-2">
                          <Pill tone={RESULT_LABEL[e.result]?.tone ?? "default"}>{RESULT_LABEL[e.result]?.label ?? e.result}</Pill>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.invested_ap.toLocaleString("ko-KR")}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.weight !== null ? e.weight.toFixed(2) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 증명서 */}
      <Dialog open={cert !== null} onOpenChange={(open) => !open && setCert(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {cert?.checks.all_valid ? <ShieldCheck className="size-5 text-success" /> : <ShieldX className="size-5 text-destructive" />}
              공정성 증명서 {cert?.cert_no}
            </DialogTitle>
            <DialogDescription>
              {cert?.payload.event.title} · {cert?.payload.tier.name} · 발급 {cert ? formatDateTimeSecKst(cert.issued_at) : ""}
            </DialogDescription>
          </DialogHeader>
          {cert ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(["applicants", "winners", "waitlisted", "excluded_by_sanction"] as const).map((k) => (
                  <div key={k} className="rounded-md bg-bg-muted p-3">
                    <p className="text-[11px] text-content-subtle">
                      {{ applicants: "응모", winners: "당첨", waitlisted: "대기", excluded_by_sanction: "제재 제외" }[k]}
                    </p>
                    <p className="text-lg font-black tabular-nums">{(cert.payload.counts[k] ?? 0).toLocaleString("ko-KR")}</p>
                  </div>
                ))}
              </div>
              <ul className="space-y-1.5">
                {Object.entries(CHECK_LABEL).map(([k, label]) => (
                  <li key={k} className="flex items-center gap-2 text-sm">
                    {cert.checks[k] ? <ShieldCheck className="size-4 text-success" /> : <ShieldX className="size-4 text-destructive" />}
                    <span className={cert.checks[k] ? "text-foreground" : "text-destructive"}>{label}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-2 rounded-md border border-border-subtle p-3">
                <HashRow label="서명 키 ID" value={cert.key_id} />
                <HashRow label="내용 해시" value={cert.payload_hash} />
                <HashRow label="응모 루트" value={String(cert.payload.entries_root ?? "")} />
                <HashRow label="결과 루트" value={String(cert.payload.results_root ?? "")} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <a href={`/api/events/${eventId}/gwasup/fairness/certificates/${cert.cert_no}/pdf`} target="_blank" rel="noopener noreferrer">
                    <Download className="size-4" /> PDF
                  </a>
                </Button>
                <Button asChild variant="secondary">
                  <a href={cert.payload.verify_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" /> 공개 검증 페이지
                  </a>
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HashRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-content-subtle">{label}</span>
      <HashText value={value} label={label} />
    </div>
  );
}
