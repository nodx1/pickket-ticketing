"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { useUnsavedSection } from "@/lib/hooks/unsaved-sections";
import { UnsavedBadge } from "@/components/shared/unsaved-badge";
// 🔴 zod 없는 파일에서 가져온다 — 스키마 파일에서 가져오면 클라이언트 번들에 zod 가 딸려온다(원칙 #14).
import { REFUND_NOTICE_MAX } from "@/lib/events/refund-notice-limits";

interface PolicyTier { daysBefore: number; feePct: number; }

/** 서버 zod 와 **같은 값**이어야 한다(`api/events/[eventId]/route.ts`). 늘리려면 양쪽을 함께. */
const MAX_TIERS = 6;

/** 화면 기본값 — **서버 값을 못 읽었을 때 이걸 저장하면 실제 규정이 날아간다.** */
const FALLBACK_TIERS: PolicyTier[] = [
  { daysBefore: 30, feePct: 0 },
  { daysBefore: 7, feePct: 30 },
  { daysBefore: 3, feePct: 50 },
  { daysBefore: 1, feePct: 80 },
  { daysBefore: 0, feePct: 100 },
];

/**
 * 취소·환불 정책 편집.
 *
 * 🔴 로드 실패를 반드시 표시해야 하는 화면이다 (2026-07-29 자체 점검).
 * 종전에는 `catch { /* ignore *\/ }` 로 삼키고 위 기본값을 그대로 보여줬다.
 * 화면이 "그럴듯한 값" 이라 주최자는 이상함을 알아챌 수 없고, 저장하는 순간
 * **실제 설정된 환불 규정이 기본값으로 덮어써진다** — 그대로 고객 분쟁이 되는 값이다.
 * 게다가 dirty 가드가 없어 아무것도 바꾸지 않아도 저장 버튼이 눌렸다.
 */
export function CancellationPolicy({ eventId }: { eventId: string }) {
  const [tiers, setTiers] = useState<PolicyTier[]>(FALLBACK_TIERS);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedSection("cancellation-policy", "취소 정책", dirty);
  const { addToast } = useToast();

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Record<string, unknown> }>(`/api/events/${eventId}`);
      // 🔴 success:false 도 실패다 — 종전엔 이 경우 catch 에 걸리지 않아 조용히 기본값이 남았다.
      if (!res.success) throw new Error("정책을 불러오지 못했습니다");
      const policy = (res.data as { cancellationPolicy?: PolicyTier[] }).cancellationPolicy;
      if (Array.isArray(policy) && policy.length > 0) setTiers(policy);

      // 안내 문구는 `homepage_design` JSONB(go 소유)에 있다. 별도 라우트라 함께 읽는다.
      // 🔴 여기서 실패해도 `loadFailed` 를 켠다 — 문구를 못 읽은 채 저장하면 **빈 문자열로 덮인다.**
      const hp = await fetchWithAuth<{ success: boolean; data: { refundNotice?: string } }>(
        `/api/events/${eventId}/homepage-design`,
      );
      if (!hp.success) throw new Error("안내 문구를 불러오지 못했습니다");
      setNotice(hp.data?.refundNotice ?? "");
      setDirty(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void fetch_(); }, [fetch_]);

  const updateTier = (idx: number, field: keyof PolicyTier, value: number) => {
    setTiers((prev) => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
    setDirty(true);
  };

  /**
   * 🔴 종전에는 서버가 준 배열을 **그리기만** 했다 — 추가도 삭제도 없었다 (2026-07-31 발견).
   * prod 저장값이 1단계였던 KLPGA 에서는 주최자가 단계를 **늘릴 방법이 아예 없었다.**
   * "환불 정책을 주최자가 정한다" 가 화면상 성립하지 않고 있었다.
   */
  const addTier = () => {
    setTiers((prev) => {
      if (prev.length >= MAX_TIERS) return prev;
      // 기존에 없는 daysBefore 를 고른다 — 중복은 서버가 거부하고(400), 공개 상세에서
      // label 이 React key 라 키 충돌도 난다.
      const used = new Set(prev.map((t) => t.daysBefore));
      let next = 0;
      while (used.has(next)) next += 1;
      return [...prev, { daysBefore: next, feePct: 100 }];
    });
    setDirty(true);
  };

  const removeTier = (idx: number) => {
    // 🔴 마지막 한 단계는 못 지운다. 빈 배열을 저장하면 v2 가 NULL 로 바꾸고, NULL 이면
    //    **플랫폼 기본단계가 조용히 적용**된다 — 화면엔 "미설정" 인데 돈은 깎인다.
    setTiers((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    setDirty(true);
  };

  const duplicateDays = tiers
    .map((t) => t.daysBefore)
    .filter((d, i, arr) => arr.indexOf(d) !== i);

  const save = async () => {
    setSaving(true);
    try {
      const sorted = [...tiers].sort((a, b) => b.daysBefore - a.daysBefore);
      // G3: cancellationPolicy 는 /settings 가 무시함 → 실제 처리 라우트(/events/[id] PATCH)로.
      const res = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ cancellationPolicy: sorted }),
      });
      // 🔴 실패를 성공처럼 넘기지 않는다 — 종전엔 success:false 일 때 아무 안내가 없어
      //    주최자가 저장된 줄 알고 화면을 떠났다.
      if (!res.success) throw new Error("저장에 실패했습니다");

      // 안내 문구는 저장소가 달라 두 번째 호출이다. PATCH 라 보낸 키만 병합된다
      // (`buildHomepageDesignPatch` — 나머지 디자인 설정은 건드리지 않는다).
      const hp = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}/homepage-design`, {
        method: "PATCH",
        body: JSON.stringify({ refundNotice: notice.trim() }),
      });
      // 🔴 여기까지 오면 **단계는 이미 저장됐다.** 문구만 실패한 것을 "저장 실패" 로 뭉치면
      //    주최자는 전부 실패한 줄 알고 단계를 다시 만진다. 무엇이 저장됐는지 정확히 말한다.
      if (!hp.success) {
        addToast({
          message: "수수료 단계는 저장됐지만 안내 문구 저장에 실패했습니다. 문구만 다시 저장해주세요.",
          variant: "error",
        });
        return; // dirty 유지 — 다시 누르면 둘 다 재전송된다(단계 저장은 멱등).
      }

      setDirty(false);
      addToast({ message: "취소 정책이 저장되었습니다.", variant: "success" });
    } catch { addToast({ message: "저장에 실패했습니다.", variant: "error" }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="animate-pulse rounded-lg border border-border bg-card p-6"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold text-foreground">
            취소/환불 정책
            <UnsavedBadge show={dirty} />
          </h3>
          <p className="mt-1 text-sm text-content-subtle">이벤트 시작 기준 일자별 취소 수수료를 설정합니다.</p>
        </div>
        <Button type="button" onClick={save} disabled={!canSaveEditor({ loading, loadFailed, dirty, saving }) || duplicateDays.length > 0}>
          <Save className="size-4" />{saving ? "저장 중..." : "취소 정책 저장"}
        </Button>
      </div>

      {loadFailed ? (
        <div className="space-y-3 rounded-lg border border-error/30 bg-error/5 p-4">
          <p className="text-sm text-error">
            현재 설정된 환불 정책을 불러오지 못했습니다. 아래 값은 <strong>실제 설정이 아니라 기본값</strong>이라,
            이 상태로 저장하면 <strong>기존 정책이 덮어써집니다</strong>. 편집을 잠갔습니다.
          </p>
          <Button type="button" variant="outline" onClick={() => void fetch_()}>다시 불러오기</Button>
        </div>
      ) : null}

      <div className={`space-y-3 ${loadFailed ? "pointer-events-none mt-4 opacity-50" : ""}`}>
        {tiers.map((tier, idx) => (
          <div key={idx} className="flex items-center gap-4 rounded-lg border border-border px-4 py-3">
            <div className="flex-1">
              <label className="text-xs text-content-muted">이벤트 시작</label>
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={tier.daysBefore} disabled={loadFailed} onChange={(e) => updateTier(idx, "daysBefore", Number(e.target.value))} className="w-20 rounded-lg border border-border bg-card px-3 py-1.5 text-sm" />
                <span className="text-sm text-content-subtle">일 전</span>
              </div>
            </div>
            <div className="flex-1">
              <label className="text-xs text-content-muted">취소 수수료</label>
              <div className="flex items-center gap-2">
                <input type="number" min="0" max="100" value={tier.feePct} disabled={loadFailed} onChange={(e) => updateTier(idx, "feePct", Number(e.target.value))} className="w-20 rounded-lg border border-border bg-card px-3 py-1.5 text-sm" />
                <span className="text-sm text-content-subtle">%</span>
              </div>
              <p className="mt-1 text-xs text-content-muted">환불 {Math.max(0, Math.min(100, 100 - tier.feePct))}%</p>
            </div>
            {/* 🔴 `loadFailed` 일 때 함께 잠근다 — 입력만 막고 버튼을 열어두면
                불러오지 못한 기본값 상태에서 단계를 지워 저장할 수 있다. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${tier.daysBefore}일 전 단계 삭제`}
              disabled={loadFailed || tiers.length <= 1}
              onClick={() => removeTier(idx)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          disabled={loadFailed || tiers.length >= MAX_TIERS}
          onClick={addTier}
        >
          <Plus className="size-4" />
          단계 추가
        </Button>
        {tiers.length >= MAX_TIERS ? (
          <p className="text-xs text-content-muted">단계는 최대 {MAX_TIERS}개까지 설정할 수 있습니다.</p>
        ) : null}
        {duplicateDays.length > 0 ? (
          <p className="text-xs text-error">
            같은 &apos;일 전&apos; 값({duplicateDays.join(", ")})이 중복됩니다. 저장할 수 없습니다.
          </p>
        ) : null}
      </div>
      <p className="mt-3 text-xs text-content-muted">
        각 단계는 <strong>&quot;N일 이내&quot;</strong>를 뜻합니다. 행사 <strong>당일 00시</strong> 기준으로 계산합니다.
        예: <code>0일 전 / 100%</code> = 행사 당일 00시부터 환불 불가, 그 전에는 전액 환불.
      </p>

      {/* 🔴 수수료 단계(숫자)로는 담을 수 없는 조건을 주최자가 직접 쓴다 (2026-07-31 대표 요구).
          예: "기상 악화로 경기 취소 시 첫 조 출발 기준 9홀 종료 전까지만 환불 가능".
          행사마다 조건이 달라 플랫폼이 문구를 정할 수 없다. */}
      <div className={`mt-5 border-t border-border pt-4 ${loadFailed ? "pointer-events-none opacity-50" : ""}`}>
        <label htmlFor="refund-notice" className="text-sm font-semibold text-foreground">
          환불 안내 문구 <span className="font-normal text-content-muted">(선택)</span>
        </label>
        <p className="mt-1 text-xs text-content-subtle">
          단계별 수수료로 표현할 수 없는 조건을 적습니다. 구매 화면의 환불 정책 아래에 그대로 표시됩니다.
        </p>
        <textarea
          id="refund-notice"
          rows={4}
          value={notice}
          disabled={loadFailed}
          maxLength={REFUND_NOTICE_MAX}
          onChange={(e) => { setNotice(e.target.value); setDirty(true); }}
          placeholder={"예) 당일 기상 악화로 경기 진행이 불가능할 경우, 주최사의 판단으로 티켓 환불이 진행될 수 있습니다.\n기상 악화로 경기가 취소될 시, 첫 조 출발 기준 9홀 종료 전까지만 환불 가능합니다."}
          className="mt-2 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
        />
        <p className="mt-1 text-right text-xs text-content-muted">
          {notice.length} / {REFUND_NOTICE_MAX}
        </p>
      </div>
    </div>
  );
}
