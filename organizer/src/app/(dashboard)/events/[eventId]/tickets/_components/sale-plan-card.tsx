"use client";

/**
 * 판매 방식 카드 — docs §5-1 의 복수 조합 지원.
 *
 * 주최자가 주 phase (membership_presale / lottery / queue_sale) 중 1~3개 조합 선택 + 비율 입력 + 각 단계 일정.
 * 저장 시:
 *   - phases 순서대로 판매 단계 생성 (target_quantity = totalSeats × ratioPct / 100)
 *   - 마지막 뒤에 waitlist_promotion + fcfs_residual 자동 추가
 *
 * 규칙:
 *   - 합계 100%
 *   - 단계 간 최소 24시간 간격
 *   - 멤버십 선택 시 팬클럽 필수
 *   - 주 phase 없이 선착순만 원하면 "모든 체크 해제 + fcfsOpensAt" 입력
 *
 * ── 레벨2 컷오버 T2-PHASE ──
 * 판매 단계 SSOT 는 v2 `phase_configs` 다(go `sale_phases` 는 DROP). 아래 두 go 라우트는
 * **go DB 를 쓰지 않는 v2 프록시**이며, 실제 검증·시퀀스 생성·저장은 v2
 * `PUT/GET /api/v1/internal/events/{id}/sale-plan` 이 수행한다. 브라우저가 v2 internal API 의
 * 서비스 토큰/HMAC 을 가질 수 없어 주최자 세션 인증용 서버 프록시가 필요하다.
 *   GET  /api/events/{eventId}/sale-phases            → v2 sale-plan 조회
 *   POST /api/events/{eventId}/sale-phases/apply-mode → v2 sale-plan 저장
 * 아래 클라이언트 검증(96h 간격·비율 100%)은 **UX 선행 힌트**일 뿐, 정본은 v2 서비스다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EVIDENCE_SIMPLE_MODE } from "@/lib/evidence-mode";
import {
  AlertTriangle,
  Check,
  Dices,
  Footprints,
  Gift,
  Repeat,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateTime2DigitKst } from "@/lib/format";

type SaleMode =
  | "membership_presale"
  | "lottery"
  | "waitlist_promotion"
  | "queue_sale"
  | "fcfs_residual";

type MainMode = "membership_presale" | "lottery" | "queue_sale";

interface PhaseRow {
  id: string;
  phaseOrder: number;
  mode: SaleMode;
  opensAt: string;
  closesAt: string | null;
  status: string;
  allocatedQuantity: number;
  targetQuantity: number | null;
  config?: { fanclub_id?: string; [key: string]: unknown };
}

interface Fanclub {
  id: string;
  name: string;
  member_count?: number;
}

interface PhaseDraft {
  mode: MainMode;
  ratioPct: number;
  opensAt: string;
  closesAt: string;
  fanclubId: string;
}

const MAIN_MODE_META: Record<
  MainMode,
  { label: string; icon: LucideIcon; desc: string }
> = {
  membership_presale: {
    label: "팬클럽 선예매",
    icon: Gift,
    desc: "연결된 팬클럽 회원만 응모 가능. 팬 점수 기반 공정 추첨.",
  },
  lottery: {
    label: "공정 추첨",
    icon: Dices,
    desc: "전체 회원 응모 → AP 가중 공정 추첨.",
  },
  queue_sale: {
    label: "대기열 판매",
    icon: Footprints,
    desc: "오픈 시각 접속 → 랜덤 큐 → 순차 구매.",
  },
};

const PHASE_LABELS: Record<SaleMode, { label: string; icon: LucideIcon }> = {
  membership_presale: { label: "팬클럽 선예매", icon: Gift },
  lottery: { label: "공정 추첨", icon: Dices },
  waitlist_promotion: { label: "대기자 자동 승격", icon: Repeat },
  queue_sale: { label: "대기열 판매", icon: Footprints },
  fcfs_residual: { label: "선착순 (잔여석)", icon: Timer },
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: "예정",
  open: "진행중",
  closed: "마감",
  allocating: "추첨 중",
  allocated: "완료",
  skipped: "건너뜀",
};

function formatDateTime(iso: string | null): string {
  // KST 고정 — 판매 개시·마감 시각이 서버 시간대에 따라 밀리면 안 된다(lib/format 참조).
  return formatDateTime2DigitKst(iso, "");
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}

/** datetime-local 문자열 (YYYY-MM-DDTHH:mm) 에 시간을 더해 반환. */
function addHoursToLocal(local: string, hours: number): string {
  if (!local) return "";
  const d = new Date(local);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() + hours * 3600 * 1000 - tz)
    .toISOString()
    .slice(0, 16);
}

/** 이전 phase 결제 마감 후 다음 phase 가 시작돼야 하는 최소 시각 (결제창 72h + 간격 24h = 96h). */
const MIN_BETWEEN_PHASES_HOURS = 96;

export function SalePlanCard({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [phases, setPhases] = useState<PhaseRow[]>([]);
  const [drafts, setDrafts] = useState<PhaseDraft[]>([]);
  const [fcfsOpensAt, setFcfsOpensAt] = useState<string>("");
  const [fanclubs, setFanclubs] = useState<Fanclub[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);

  useUnsavedChanges(dirty);

  const fetchPhases = useCallback(async () => {
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/sale-phases`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { data?: PhaseRow[] };
      const list = payload.data ?? [];
      setPhases(list);

      // 기존 저장값 → drafts 로 복원
      const main = list.filter((p) =>
        ["membership_presale", "lottery", "queue_sale"].includes(p.mode),
      );
      if (main.length > 0) {
        setDrafts(
          main.map((p) => ({
            mode: p.mode as MainMode,
            ratioPct: 0, // target_quantity 로 역산 가능하지만 UI 입력용은 아래에서 계산
            opensAt: toLocalInput(p.opensAt),
            closesAt: toLocalInput(p.closesAt),
            fanclubId: p.config?.fanclub_id ?? "",
          })),
        );
        // 비율 역산 (target_quantity 합 기준)
        const totalTarget = main.reduce((s, p) => s + (p.targetQuantity ?? 0), 0);
        if (totalTarget > 0) {
          setDrafts(
            main.map((p) => ({
              mode: p.mode as MainMode,
              ratioPct: Math.round(((p.targetQuantity ?? 0) / totalTarget) * 100),
              opensAt: toLocalInput(p.opensAt),
              closesAt: toLocalInput(p.closesAt),
              fanclubId: p.config?.fanclub_id ?? "",
            })),
          );
        }
      } else {
        const fcfs = list.find((p) => p.mode === "fcfs_residual");
        if (fcfs) setFcfsOpensAt(toLocalInput(fcfs.opensAt));
      }
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  const fetchFanclubs = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/fanclubs", { credentials: "include" });
      if (!res.ok) return;
      const payload = (await res.json()) as { data?: Fanclub[] | { items?: Fanclub[] } };
      const list = Array.isArray(payload.data)
        ? payload.data
        : ((payload.data as { items?: Fanclub[] } | undefined)?.items ?? []);
      setFanclubs(list);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchPhases();
    void fetchFanclubs();
  }, [fetchPhases, fetchFanclubs]);

  const hasActivePhase = phases.some((p) =>
    ["open", "closed", "allocating", "allocated"].includes(p.status),
  );

  const selectedModes = new Set(drafts.map((d) => d.mode));
  const ratioSum = drafts.reduce((s, d) => s + (d.ratioPct || 0), 0);

  function toggleMode(mode: MainMode) {
    if (selectedModes.has(mode)) {
      setDrafts((prev) => prev.filter((d) => d.mode !== mode));
      setDirty(true);
    } else {
      if (drafts.length >= 3) {
        showError("판매 단계는 최대 3개까지 선택할 수 있습니다");
        return;
      }
      setDrafts((prev) => {
        // 새 phase opens_at 자동 제안: 이전 phase 마감 + 96h (결제창 72h + 간격 24h)
        const lastPhase = prev[prev.length - 1];
        const suggestedOpens =
          lastPhase && lastPhase.closesAt
            ? addHoursToLocal(lastPhase.closesAt, MIN_BETWEEN_PHASES_HOURS)
            : "";
        const suggestedCloses = suggestedOpens
          ? addHoursToLocal(suggestedOpens, 24 * 7) // 기본 응모 기간 7일
          : "";
        return [
          ...prev,
          {
            mode,
            ratioPct: 0,
            opensAt: suggestedOpens,
            closesAt: suggestedCloses,
            fanclubId: "",
          },
        ];
      });
      setDirty(true);
    }
  }

  function updateDraft(idx: number, patch: Partial<PhaseDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
    setDirty(true);
  }

  function moveDraft(idx: number, dir: -1 | 1) {
    setDrafts((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload =
        drafts.length === 0
          ? {
              phases: [],
              fcfsOpensAt: fcfsOpensAt
                ? new Date(fcfsOpensAt).toISOString()
                : undefined,
            }
          : {
              phases: drafts.map((d) => ({
                mode: d.mode,
                ratioPct: d.ratioPct,
                opensAt: new Date(d.opensAt).toISOString(),
                closesAt: new Date(d.closesAt).toISOString(),
                fanclubId: d.mode === "membership_presale" ? d.fanclubId : undefined,
              })),
            };

      const res = await fetchWithRefresh(`/api/events/${eventId}/sale-phases/apply-mode`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(
          (body as { error?: string }).error ?? "판매 방식 저장에 실패했습니다",
        );
        return;
      }
      showSuccess("판매 방식이 저장되었습니다");
      await fetchPhases();
      // 왼쪽 메뉴(가중치 추첨 설정·추첨 결과 등)는 서버 레이아웃이 판매 단계를 보고 정하므로 다시 그린다.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const isFcfsOnly = drafts.length === 0;

  const ratioWarning = useMemo(() => {
    if (isFcfsOnly) return null;
    if (Math.round(ratioSum) !== 100) {
      return `합계 ${ratioSum}% — 100% 로 맞춰주세요`;
    }
    return null;
  }, [isFcfsOnly, ratioSum]);

  if (loading) return null;

  return (
    <Card className="border-border bg-card/95">
      <CardHeader>
        <CardTitle className="text-foreground">판매 방식</CardTitle>
        <p className="text-xs text-content-subtle">
          최대 3개 조합 · 단계 간 최소 96시간 간격 (결제창 72h + 간격 24h) · 이전 단계 미결제/잔여는 다음 단계로 자동 이월 · 최종 단계 뒤에 대기자 자동 승격 + 잔여 선착순이 자동 추가됩니다.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {hasActivePhase && (
          <div className="flex items-center gap-1.5 rounded-md bg-warning/10 p-3 text-xs text-warning-foreground">
            <AlertTriangle className="size-3.5 shrink-0" />
            이미 진행중인 판매 단계가 있어 설정 변경이 제한됩니다.
          </div>
        )}

        {/* 모드 선택 체크박스 */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold">
            {EVIDENCE_SIMPLE_MODE
              ? "판매 단계 — 「공정 추첨」을 체크하면 가중치 추첨으로 팝니다(미선택 시 선착순)"
              : "판매 단계 선택 (1~3개, 미선택 시 선착순 단독)"}
          </Label>
          <div className={EVIDENCE_SIMPLE_MODE ? "grid gap-2" : "grid gap-2 sm:grid-cols-3"}>
            {/* 증빙용 간단 모드는 과업 대상인 공정 추첨만 보인다(팬클럽 선예매·대기열 판매는 숨김). */}
            {(EVIDENCE_SIMPLE_MODE ? (["lottery"] as MainMode[]) : (Object.keys(MAIN_MODE_META) as MainMode[])).map((m) => {
              const meta = MAIN_MODE_META[m];
              const ModeIcon = meta.icon;
              const checked = selectedModes.has(m);
              return (
                <label
                  key={m}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition ${
                    checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    onChange={() => toggleMode(m)}
                    disabled={hasActivePhase}
                  />
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                      <ModeIcon className="size-4 shrink-0" />
                      {meta.label}
                    </div>
                    <p className="text-[11px] text-content-subtle">{meta.desc}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* 선택된 phase 별 입력 폼 */}
        {drafts.length > 0 && (
          <div className="space-y-3">
            {drafts.map((d, idx) => {
              const meta = MAIN_MODE_META[d.mode];
              const DraftIcon = meta.icon;
              const prev = idx > 0 ? drafts[idx - 1] : null;
              let gapWarning: string | null = null;
              if (prev && prev.closesAt && d.opensAt) {
                const gapHours =
                  (new Date(d.opensAt).getTime() - new Date(prev.closesAt).getTime()) /
                  (3600 * 1000);
                if (gapHours < MIN_BETWEEN_PHASES_HOURS) {
                  gapWarning = `이전 단계 마감 후 최소 ${MIN_BETWEEN_PHASES_HOURS}시간 뒤에 시작해야 합니다 (현재 ${gapHours.toFixed(1)}h)`;
                }
              }
              return (
                <div
                  key={`${d.mode}-${idx}`}
                  className="rounded-lg border border-border bg-muted/10 p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                        {idx + 1}단계
                      </span>
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        <DraftIcon className="size-4 shrink-0" />
                        {meta.label}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => moveDraft(idx, -1)}
                        disabled={idx === 0 || hasActivePhase}
                      >
                        ▲
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => moveDraft(idx, 1)}
                        disabled={idx === drafts.length - 1 || hasActivePhase}
                      >
                        ▼
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleMode(d.mode)}
                        disabled={hasActivePhase}
                        aria-label="단계 제거"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-xs">좌석 비율</Label>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          value={d.ratioPct || ""}
                          onChange={(e) =>
                            updateDraft(idx, { ratioPct: Number(e.target.value) })
                          }
                          disabled={hasActivePhase}
                        />
                        <span className="text-xs text-content-subtle">%</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">시작</Label>
                      <Input
                        type="datetime-local"
                        value={d.opensAt}
                        onChange={(e) => updateDraft(idx, { opensAt: e.target.value })}
                        disabled={hasActivePhase}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">마감</Label>
                      <Input
                        type="datetime-local"
                        value={d.closesAt}
                        onChange={(e) => updateDraft(idx, { closesAt: e.target.value })}
                        disabled={hasActivePhase}
                      />
                    </div>
                  </div>

                  {gapWarning && (
                    <div className="mt-2 flex items-center gap-1.5 rounded-md bg-error/10 px-3 py-2 text-[11px] text-error">
                      <AlertTriangle className="size-3 shrink-0" />
                      {gapWarning}
                    </div>
                  )}

                  {d.mode === "membership_presale" && (
                    <div className="mt-3 space-y-1">
                      <Label className="text-xs">연결할 팬클럽</Label>
                      {fanclubs.length === 0 ? (
                        <div className="rounded-md border border-border bg-muted/30 p-2 text-[11px] text-content-subtle">
                          등록된 팬클럽이 없습니다. 팬클럽 관리에서 먼저 생성해주세요.
                        </div>
                      ) : (
                        <select
                          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                          value={d.fanclubId}
                          onChange={(e) => updateDraft(idx, { fanclubId: e.target.value })}
                          disabled={hasActivePhase}
                        >
                          <option value="">-- 팬클럽 선택 --</option>
                          {fanclubs.map((fc) => (
                            <option key={fc.id} value={fc.id}>
                              {fc.name}
                              {typeof fc.member_count === "number" ? ` (${fc.member_count}명)` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div
              className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-xs ${
                ratioWarning
                  ? "bg-error/10 text-error"
                  : "bg-success/10 text-success"
              }`}
            >
              {ratioWarning ? (
                <>
                  <AlertTriangle className="size-3 shrink-0" />
                  {ratioWarning}
                </>
              ) : (
                <>
                  <Check className="size-3 shrink-0" />
                  비율 합계 {ratioSum}%
                </>
              )}
            </div>
          </div>
        )}

        {/* fcfs-only 입력 */}
        {isFcfsOnly && (
          <div className="space-y-1.5">
            <Label className="text-xs">선착순 판매 시작</Label>
            <Input
              type="datetime-local"
              value={fcfsOpensAt}
              onChange={(e) => { setFcfsOpensAt(e.target.value); setDirty(true); }}
              disabled={hasActivePhase}
            />
            <p className="text-[11px] text-content-subtle">
              추첨/멤버십 없이 오픈 시각부터 바로 선착순 판매.
            </p>
          </div>
        )}

        {/* 단계 미리보기 */}
        {phases.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-semibold text-foreground">예정된 판매 단계</p>
            <div className="space-y-1.5">
              {phases.map((p) => {
                const label = PHASE_LABELS[p.mode];
                const PhaseIcon = label?.icon;
                return (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-content-subtle">
                        {p.phaseOrder}.
                      </span>
                      {PhaseIcon ? <PhaseIcon className="size-3.5 shrink-0" /> : null}
                      <span className="font-semibold">{label?.label}</span>
                      {p.targetQuantity !== null && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          {p.targetQuantity}석
                        </span>
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          p.status === "open"
                            ? "bg-success/10 text-success"
                            : p.status === "allocated"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-content-subtle"
                        }`}
                      >
                        {STATUS_LABELS[p.status] ?? p.status}
                      </span>
                    </div>
                    <div className="text-content-subtle">
                      {formatDateTime(p.opensAt)}
                      {p.closesAt && ` ~ ${formatDateTime(p.closesAt)}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={() => void handleSave()}
            disabled={saving || hasActivePhase || Boolean(ratioWarning)}
          >
            {saving ? "저장 중..." : "판매 방식 저장"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
