"use client";

/**
 * 가중치 추첨 설정 (과업 3-2 ① "가중치 추첨 설정").
 *
 * 주최사가 응모자에게 어떤 기준으로 당첨 확률을 줄지 정한다.
 *  - 프리셋 / 계수 직접 조정 / 배분 방식(공정 추첨 · 가중 배분)
 *  - 미리보기: 응모자 유형별 예상 당첨 확률(v2 시뮬레이션)
 *  - 응모가 시작된 등급은 그 시점 설정으로 **잠긴다**(정책 해시가 공정성 증명서에 실림)
 * 데이터: /api/events/{id}/gwasup/lottery-policy → v2 /internal/events/{id}/lottery-policy
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Dices, Gauge, Lock, RotateCcw, Save, Scale, Sparkles, Users } from "lucide-react";

import { BarRow, HashText, PageHeader, Pill, Section, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { formatDateTimeKst } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import { cn } from "@/lib/utils";
import type { EventPolicyView, SimulationResult, WeightPolicy } from "@/lib/v2/gwasup-client";

const PRESET_META: Record<string, { title: string; body: string }> = {
  standard: { title: "기본", body: "피켓 기본값. AP 투입·팬 활동·연속 낙첨을 함께 반영합니다." },
  uniform: { title: "모두 같은 확률", body: "가중치 없이 순수 무작위로 뽑습니다." },
  fan_first: { title: "팬 활동 우대", body: "팬클럽·관람 이력 같은 팬 활동을 두 배로 반영합니다." },
  loyalty_first: { title: "오래 활동한 팬 우대", body: "정상적으로 오래 활동한 계정에 가산점을 줍니다. 제재 이력이 있으면 0점입니다." },
};

interface SliderSpec {
  key: keyof WeightPolicy;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderSpec[] = [
  { key: "base_weight", label: "기본 점수", help: "모든 응모자가 똑같이 받는 점수. 클수록 다른 항목의 영향이 줄어듭니다.", min: 1, max: 300, step: 1 },
  { key: "ap_scale", label: "AP 투입 반영", help: "AP를 많이 넣을수록 받는 가산점의 강도(로그 비례 — 많이 넣어도 격차는 완만).", min: 0, max: 50, step: 1 },
  { key: "ap_cap", label: "AP 반영 상한", help: "이 이상 넣어도 점수가 더 오르지 않습니다.", min: 0, max: 10000, step: 100 },
  { key: "fan_coef", label: "팬 활동 반영", help: "팬클럽 가입·관람 이력 등 팬 점수의 반영 강도.", min: 0, max: 300, step: 5 },
  { key: "pity_coef", label: "연속 낙첨 보정", help: "계속 떨어진 사람에게 주는 보정의 강도.", min: 0, max: 500, step: 10 },
  { key: "tenure_coef", label: "정상 누적 시간 반영", help: "가입 기간과 실제 입장 이력으로 계산한 점수(0~1)에 곱해 더합니다.", min: 0, max: 300, step: 5 },
];

const DEFAULT_PROFILES = [
  { key: "newcomer", label: "신규 가입자", count: 400, invested_ap: 0, fan_weight: 1.0, pity_bonus: 1.0, tenure_score: 0.0 },
  { key: "casual", label: "일반 응모자", count: 400, invested_ap: 300, fan_weight: 1.0, pity_bonus: 1.0, tenure_score: 0.3 },
  { key: "fan", label: "팬클럽 회원", count: 150, invested_ap: 1000, fan_weight: 1.5, pity_bonus: 1.0, tenure_score: 0.6 },
  { key: "veteran", label: "장기 활동 팬", count: 40, invested_ap: 2000, fan_weight: 1.8, pity_bonus: 1.0, tenure_score: 1.0 },
  { key: "unlucky", label: "연속 낙첨자", count: 10, invested_ap: 300, fan_weight: 1.0, pity_bonus: 1.6, tenure_score: 0.3 },
];

type Scope = "event" | string; // "event" 또는 tier_id

export default function LotteryPolicyPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { addToast } = useToast();
  const [view, setView] = useState<EventPolicyView | null>(null);
  const [scope, setScope] = useState<Scope>("event");
  const [draft, setDraft] = useState<WeightPolicy | null>(null);
  const [preset, setPreset] = useState<string>("standard");
  const [saving, setSaving] = useState(false);
  const [seats, setSeats] = useState(100);
  const [profiles, setProfiles] = useState(DEFAULT_PROFILES);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await gw<EventPolicyView>(eventId, "lottery-policy");
      setView(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오지 못했습니다");
      return null;
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 범위가 바뀌면 그 범위의 저장값(없으면 상위 → 기본)으로 초안을 맞춘다.
  useEffect(() => {
    if (!view) return;
    const tier = scope === "event" ? null : view.tiers.find((t) => t.tier_id === scope);
    const record = tier?.policy ?? (scope === "event" ? view.event_policy : null) ?? view.event_policy;
    setDraft({ ...(record?.policy ?? view.defaults) });
    setPreset(record?.preset ?? "standard");
    setSim(null);
  }, [view, scope]);

  const lockedTier = scope === "event" ? null : view?.tiers.find((t) => t.tier_id === scope)?.locked_pool ?? null;
  const lotteryTiers = useMemo(() => view?.tiers.filter((t) => t.sale_mode === "point_lottery") ?? [], [view]);

  const runSimulation = useCallback(
    async (policy: WeightPolicy | null = draft) => {
      if (!policy) return;
      setSimLoading(true);
      try {
        setSim(await gw<SimulationResult>(eventId, "lottery-policy/simulate", { method: "POST", json: { policy, seats, profiles, iterations: 400 } }));
      } catch (err) {
        addToast({ message: err instanceof Error ? err.message : "미리보기에 실패했습니다", variant: "error" });
      } finally {
        setSimLoading(false);
      }
    },
    [addToast, draft, eventId, profiles, seats],
  );

  const applyPreset = (name: string) => {
    if (!view) return;
    setPreset(name);
    setDraft((d) => ({ ...view.presets[name], algorithm: d?.algorithm ?? "weighted_lottery" }));
    setSim(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await gw(eventId, "lottery-policy", {
        method: "PUT",
        json: { tierId: scope === "event" ? null : scope, preset, policy: draft },
      });
      addToast({ message: "가중치 설정을 저장했습니다. 다음에 시작되는 응모부터 적용됩니다.", variant: "success" });
      await load();
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : "저장에 실패했습니다", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (error && !view) {
    return (
      <div className="rounded-lg border border-border bg-card p-10 text-center">
        <p className="font-semibold text-foreground">가중치 설정을 불러오지 못했습니다</p>
        <p className="mt-1 text-sm text-content-subtle">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => void load()}>
          다시 시도
        </Button>
      </div>
    );
  }
  if (!view || !draft) {
    return <div className="h-96 animate-pulse rounded-lg bg-bg-muted" />;
  }

  const set = (key: keyof WeightPolicy, value: number | string) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setPreset("custom");
  };
  const maxProb = Math.max(0.0001, ...(sim?.profiles.map((p) => p.win_probability) ?? [0]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="판매·발권"
        title="가중치 추첨 설정"
        description={
          <>
            응모자에게 어떤 기준으로 당첨 확률을 줄지 정합니다. 등급의 첫 응모가 들어오는 순간 그때의 설정이{" "}
            <b className="text-foreground">잠기고</b>, 설정값의 해시가 공정성 증명서에 기록됩니다. 잠긴 뒤에 바꾼 설정은 그 추첨에
            영향을 주지 않습니다.
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => applyPreset("standard")} disabled={Boolean(lockedTier)}>
              <RotateCcw className="size-4" /> 기본값으로
            </Button>
            <Button onClick={() => void save()} disabled={saving || Boolean(lockedTier)}>
              <Save className="size-4" /> {saving ? "저장 중…" : "저장"}
            </Button>
          </>
        }
      />

      {/* 범위 */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="설정 범위">
        <ScopeTab active={scope === "event"} onClick={() => setScope("event")} label="이벤트 공통" />
        {lotteryTiers.map((t) => (
          <ScopeTab
            key={t.tier_id}
            active={scope === t.tier_id}
            onClick={() => setScope(t.tier_id)}
            label={t.name}
            locked={Boolean(t.locked_pool)}
            custom={Boolean(t.policy)}
          />
        ))}
        {lotteryTiers.length === 0 ? (
          <p className="self-center text-xs text-content-subtle">공정 추첨 등급이 아직 없습니다. 이벤트 공통 설정이 새 등급에 적용됩니다.</p>
        ) : null}
      </div>

      {lockedTier ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <Lock className="size-4 text-primary" />
          <span className="font-semibold text-foreground">이 등급은 응모가 시작되어 설정이 잠겼습니다.</span>
          <span className="text-content-subtle">잠긴 시각 {lockedTier.locked_at ? formatDateTimeKst(lockedTier.locked_at) : "-"}</span>
          <HashText value={lockedTier.policy_hash} label="정책 해시" />
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-6">
          <Section title="프리셋" description="자주 쓰는 설정을 한 번에 고릅니다. 고른 뒤 아래에서 세부 값을 바꿀 수 있습니다.">
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(PRESET_META).map(([name, meta]) => (
                <button
                  key={name}
                  type="button"
                  disabled={Boolean(lockedTier)}
                  onClick={() => applyPreset(name)}
                  className={cn(
                    "rounded-lg border p-4 text-left transition disabled:opacity-60",
                    preset === name ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border hover:border-primary/40 hover:bg-bg-muted",
                  )}
                >
                  <p className="text-sm font-bold text-foreground">{meta.title}</p>
                  <p className="mt-1 text-xs leading-5 text-content-subtle">{meta.body}</p>
                </button>
              ))}
            </div>
            {preset === "custom" ? <p className="mt-3 text-xs text-primary">직접 조정한 값입니다.</p> : null}
          </Section>

          <Section title="배분 방식" description="당첨자를 정하는 방법입니다.">
            <div className="grid gap-3 sm:grid-cols-2">
              <MethodCard
                active={draft.algorithm === "weighted_lottery"}
                disabled={Boolean(lockedTier)}
                onClick={() => set("algorithm", "weighted_lottery")}
                icon={Dices}
                title="공정 추첨"
                body="점수가 높을수록 당첨 확률이 높아지는 가중 무작위 추첨입니다. 점수가 낮아도 당첨 기회가 있습니다."
                note="기본값"
              />
              <MethodCard
                active={draft.algorithm === "weighted_allocation"}
                disabled={Boolean(lockedTier)}
                onClick={() => set("algorithm", "weighted_allocation")}
                icon={Scale}
                title="가중 배분"
                body="투입 AP × 점수가 높은 순서로 좌석을 배정합니다. 당첨자는 투입 AP 전부가 아니라 바로 아래 탈락자 기준 가격만 쓰고 나머지는 돌려받으며, 낙첨자는 전액 돌려받습니다."
                note="1인 1매"
              />
            </div>
          </Section>

          <Section title="세부 값" description="당첨 점수 = 기본 점수 + AP 가산 + 팬 활동 보정 + 연속 낙첨 보정 + 누적 시간 가산">
            <div className="space-y-5">
              {SLIDERS.map((s) => {
                const value = Number(draft[s.key]);
                return (
                  <div key={s.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <label htmlFor={`slider-${s.key}`} className="text-sm font-semibold text-foreground">
                        {s.label}
                      </label>
                      <input
                        type="number"
                        aria-label={`${s.label} 값`}
                        value={value}
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        disabled={Boolean(lockedTier)}
                        onChange={(e) => set(s.key, Math.min(s.max, Math.max(s.min, Number(e.target.value) || 0)))}
                        className="w-24 rounded-md border border-border bg-card px-2 py-1 text-right text-sm tabular-nums text-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
                    <input
                      id={`slider-${s.key}`}
                      type="range"
                      min={s.min}
                      max={s.max}
                      step={s.step}
                      value={value}
                      disabled={Boolean(lockedTier)}
                      onChange={(e) => set(s.key, Number(e.target.value))}
                      className="mt-2 w-full accent-[var(--primary)]"
                    />
                    <p className="mt-1 text-xs text-content-subtle">{s.help}</p>
                  </div>
                );
              })}
            </div>
          </Section>
        </div>

        <div className="space-y-6">
          <Section
            title="미리보기"
            description="이 설정이면 응모자 유형별로 당첨 확률이 어떻게 되는지 계산해 봅니다(실제 추첨과 같은 방식으로 400번 반복)."
            actions={
              <Button size="sm" onClick={() => void runSimulation()} disabled={simLoading}>
                <Sparkles className="size-4" /> {simLoading ? "계산 중…" : "계산"}
              </Button>
            }
          >
            <div className="mb-4 flex items-center gap-3 text-sm">
              <label htmlFor="sim-seats" className="text-content-subtle">
                좌석 수
              </label>
              <input
                id="sim-seats"
                type="number"
                min={1}
                max={100000}
                value={seats}
                onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
                className="w-24 rounded-md border border-border bg-card px-2 py-1 text-right tabular-nums focus:border-primary focus:outline-none"
              />
              <span className="text-content-subtle">
                응모 {profiles.reduce((a, p) => a + p.count, 0).toLocaleString("ko-KR")}명
              </span>
            </div>
            <div className="space-y-2">
              {profiles.map((p, idx) => {
                const result = sim?.profiles.find((r) => r.key === p.key);
                return (
                  <div key={p.key} className="rounded-md border border-border-subtle p-3">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-semibold text-foreground">{p.label}</span>
                      <span className="flex items-center gap-1 text-xs text-content-subtle">
                        <Users className="size-3.5" />
                        <input
                          type="number"
                          aria-label={`${p.label} 인원`}
                          min={0}
                          max={200000}
                          value={p.count}
                          onChange={(e) =>
                            setProfiles((prev) => prev.map((q, i) => (i === idx ? { ...q, count: Math.max(0, Number(e.target.value) || 0) } : q)))
                          }
                          className="w-16 rounded border border-border bg-card px-1 text-right tabular-nums"
                        />
                        명
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-content-subtle">
                      AP {p.invested_ap.toLocaleString("ko-KR")} · 팬 점수 {p.fan_weight} · 누적 시간 {p.tenure_score}
                      {p.pity_bonus > 1 ? ` · 연속 낙첨 보정 ${p.pity_bonus}` : ""}
                    </p>
                    {result ? (
                      <div className="mt-2">
                        <BarRow label={`1인 점수 ${result.weight.toFixed(1)}`} value={result.win_probability * 100} max={maxProb * 100} suffix="%" />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {sim ? (
              <p className="mt-3 text-xs text-content-subtle">
                경쟁률 {sim.competition_ratio ?? "-"} : 1 · 정책 해시 <HashText value={sim.policy_hash} />
              </p>
            ) : (
              <p className="mt-3 text-xs text-content-subtle">‘계산’을 누르면 유형별 당첨 확률이 막대로 표시됩니다.</p>
            )}
          </Section>

          <Section title="공정성 보장" description="설정값이 추첨에 어떻게 묶이는지">
            <ul className="space-y-3 text-sm text-content-subtle">
              <li className="flex gap-2">
                <Lock className="mt-0.5 size-4 shrink-0 text-primary" />
                첫 응모 순간 설정이 잠기고, 같은 순간 추첨 시드의 해시가 먼저 공개됩니다.
              </li>
              <li className="flex gap-2">
                <Gauge className="mt-0.5 size-4 shrink-0 text-primary" />
                응모 마감 때 응모자별 점수를 확정해 Merkle 루트로 묶은 뒤에 추첨합니다.
              </li>
              <li className="flex gap-2">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                추첨이 끝나면 ‘공정성 증명서’ 메뉴에서 전자서명된 증명서를 발급할 수 있습니다.
              </li>
            </ul>
            {lotteryTiers.some((t) => t.locked_pool) ? (
              <div className="mt-4 space-y-2">
                {lotteryTiers
                  .filter((t) => t.locked_pool)
                  .map((t) => (
                    <div key={t.tier_id} className="flex items-center justify-between gap-2 rounded-md bg-bg-muted px-3 py-2 text-xs">
                      <span className="font-semibold text-foreground">{t.name}</span>
                      <Pill tone="primary">
                        <Lock className="size-3" /> 잠김
                      </Pill>
                    </div>
                  ))}
              </div>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function ScopeTab({ active, onClick, label, locked, custom }: { active: boolean; onClick: () => void; label: string; locked?: boolean; custom?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-content-subtle hover:border-primary/40 hover:text-foreground",
      )}
    >
      {locked ? <Lock className="size-3.5" /> : null}
      {label}
      {custom && !active ? <span className="size-1.5 rounded-full bg-primary" aria-label="등급 전용 설정" /> : null}
    </button>
  );
}

function MethodCard({
  active,
  disabled,
  onClick,
  icon: Icon,
  title,
  body,
  note,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: typeof Dices;
  title: string;
  body: string;
  note: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border p-4 text-left transition disabled:opacity-60",
        active ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border hover:border-primary/40 hover:bg-bg-muted",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <Pill tone={active ? "primary" : "default"}>{note}</Pill>
      </div>
      <p className="mt-3 text-sm font-bold text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-5 text-content-subtle">{body}</p>
    </button>
  );
}
