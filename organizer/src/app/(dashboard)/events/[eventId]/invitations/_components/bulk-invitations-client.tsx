"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, Users, Eye, LogIn, Clock, Plus, Trash2, RotateCcw, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { listAdmissionDays } from "@/lib/admission-days";
import { Input } from "@/components/ui/input";
import { parseRecipients, type ParsedRecipient } from "./parse-recipients";
import { InvitationPreview } from "./invitation-preview";
import { buildBulkPlaceholder } from "./bulk-placeholder";
import { ADD_QTY_MAX, addOneRecipient, countByPhone, mergeRecipients, removeAt, repeatRecipient } from "./staging";
import { DispatchReadiness, type MessagingReadiness } from "./dispatch-readiness";
import { formatDateKst, formatDateShortKst } from "@/lib/format";
import {
  INVITATION_ADMISSION_NOTICE,
  INVITATION_REQUIRES_ADMISSION_DAY,
} from "@/lib/invitations/admission-policy";
import { canResendInvitation, resendableIds } from "@/lib/invitations/resend-policy";
import { InvitationStatusCell } from "./invitation-status-cell";

interface EventInfo { admissionMode: string; startsAt: string | null; endsAt: string | null; title: string; venue: string | null }
interface Invitation {
  id: string;
  recipientName: string;
  phone: string | null;
  ticketNumber: string | null;
  admissionDay: string | null;
  status: string;
  failureReason: string | null;
  createdAt: string;
  /**
   * 발송 큐 상태 — `queued | sending | sent | failed`.
   * 🔴 `undefined`(v2 구버전, 정보 없음)와 `null`(큐 행 없음 = 영원히 안 나감)은 뜻이 다르다.
   */
  dispatchStatus?: string | null;
  /** 🔴 보낸 대상이 지금 주인이 아니다 — 재발송이 필요한 상태(2026-08-12). */
  dispatchStale?: boolean;
  dispatchUpdatedAt?: string | null;
  sendEpoch?: number | null;
  /**
   * 발송 시각. 🔴 재발송 버튼의 표시 조건이다 — 값이 있으면 이미 받은 사람이므로
   * 버튼을 감춘다(누르면 한 장 더 간다). API 는 종전부터 내려주고 있었는데
   * 화면 타입이 받지 않아 쓰이지 못했다(`invitations/route.ts:64`).
   */
  sentAt: string | null;
}
interface BulkResult {
  requested: number;
  issued: number;
  atLimit: number;
  invalid: number;
  failed: number;
  /** 같은 명단을 이미 처리했다 — 저장된 결과 재사용(추가 발급 없음). */
  replayed?: boolean;
  /** 같은 명단이 지금 처리 중이다(동시 클릭). */
  inProgress?: boolean;
  /** 배치 지문 — 운영 문의 시 어느 명단이 막혔는지 특정하는 값. */
  batchFingerprint?: string;
}

export function BulkInvitationsClient({ eventId }: { eventId: string }) {
  const { addToast } = useToast();
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [rows, setRows] = useState<Invitation[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 멱등 해제 재발송 확인 — 일반 발송과 **다른** 다이얼로그다(문구가 달라야 한다). */
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);
  const [messaging, setMessaging] = useState<MessagingReadiness | null>(null);
  // 한 명씩 추가 폼 — 붙여넣기와 **병행**한다. VIP 한 명 넣으려고 엑셀을 열지 않아도 된다.
  const [oneName, setOneName] = useState("");
  const [onePhone, setOnePhone] = useState("");
  const [oneError, setOneError] = useState<string | null>(null);
  // 장수 — 같은 번호를 몇 줄 담을지. 🔴 상한 판정 아님(정본은 v2 CHECK+409). staging.repeatRecipient 주석 참조.
  const [oneQty, setOneQty] = useState(1);
  // 발송 전 확정 목록. 붙여넣기 파싱분 + 한 명씩 추가분이 여기 모인다.
  const [staged, setStaged] = useState<ParsedRecipient[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [inputMode, setInputMode] = useState<"one" | "bulk">("one");

  /**
   * 🔴 초대권은 **행사 설정과 무관하게** 입장일을 받지 않는다 (2026-07-30 요건).
   *
   * 종전: `event?.admissionMode === "daypass"` 가 이 값을 결정해, daypass 행사면
   * 수신자마다 날짜를 요구하고 그대로 `event_invitations.admission_day` 에 박았다
   * (prod 초대권 3건이 전부 `2026-08-20` 고정 상태였다).
   * 정책·근거는 `@/lib/invitations/admission-policy` 참조.
   */
  const collectsAdmissionDay: boolean = INVITATION_REQUIRES_ADMISSION_DAY;
  const dayValues = useMemo(
    () => (collectsAdmissionDay ? listAdmissionDays(event?.startsAt, event?.endsAt).map((d) => d.value) : []),
    [collectsAdmissionDay, event?.startsAt, event?.endsAt],
  );

  // 입력 텍스트 파싱 결과(미리보기·검증). daypass 면 지정일 필수+기간 검증.
  const parsed = useMemo(
    () => parseRecipients(text, { requireAdmissionDay: collectsAdmissionDay, validDays: collectsAdmissionDay ? dayValues : undefined }),
    [text, collectsAdmissionDay, dayValues],
  );

  const loadList = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: { invitations: Invitation[]; summary: Record<string, number>; messaging?: MessagingReadiness } }>(
        `/api/events/${eventId}/invitations`,
      );
      if (res.success) {
        setRows(res.data.invitations);
        setSummary(res.data.summary);
        setMessaging(res.data.messaging ?? null);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    async function loadEvent() {
      try {
        const res = await fetchWithAuth<{ success: boolean; data: { admissionMode?: string | null; startsAt?: string | null; endsAt?: string | null; title?: string | null; venue?: string | null } }>(
          `/api/events/${eventId}`,
        );
        if (res.success) {
          setEvent({
            admissionMode: res.data.admissionMode ?? "single",
            startsAt: res.data.startsAt ?? null,
            endsAt: res.data.endsAt ?? null,
            title: res.data.title ?? "",
            venue: res.data.venue ?? null,
          });
        }
      } catch { /* ignore */ }
    }
    void loadEvent();
  }, [eventId]);

  function mergeStaged(next: ParsedRecipient[]) {
    setStaged((prev) => mergeRecipients(prev, next));
  }

  function addPasted() {
    if (parsed.recipients.length === 0) return;
    mergeStaged(parsed.recipients);
    setText("");
  }

  function addOne() {
    const res = addOneRecipient({
      name: oneName,
      phone: onePhone,
      // 정책: 초대권은 입장일 미지정 — 값을 넣지 않는다.
      requireAdmissionDay: collectsAdmissionDay,
      validDays: dayValues,
      staged,
    });
    if (!res.ok) {
      setOneError(res.reason);
      return;
    }
    setOneError(null);
    // 🔴 장수만큼 같은 줄을 담는다. 손으로 N 번 입력하던 것을 대체한다(대표 요청 2026-07-31).
    mergeStaged(repeatRecipient(res.recipient, oneQty));
    setOneName("");
    setOnePhone("");
    setOneQty(1);
  }

  const bulkPlaceholder = useMemo(() => buildBulkPlaceholder(collectsAdmissionDay, dayValues), [collectsAdmissionDay, dayValues]);

  /**
   * 회수 대상(확인 다이얼로그) · 진행 중 id.
   *
   * 🔴 회수는 **되돌릴 수 없다** — 보낸 딥링크가 즉시 죽고 티켓이 `cancelled` 된다.
   *    그래서 ① 확인 다이얼로그 ② 진행 중 잠금 ③ 상태별 비활성 세 겹으로 감싼다.
   *    (서버도 이미 회수됨 409 · 입장완료 409 로 막는다 — 화면은 첫 방어선일 뿐이다.)
   */
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function doRevoke() {
    const target = revokeTarget;
    if (!target || revoking) return;   // 재진입 가드 — 두 번 눌리면 두 번 호출된다
    setRevoking(target.id);
    try {
      const res = await fetchWithAuth<{ success: boolean; error?: string }>(
        `/api/events/${eventId}/invitations/${target.id}`,
        { method: "POST", body: JSON.stringify({ action: "revoke" }) },
      );
      if (res.success) {
        addToast({ message: `${target.recipientName} 초대권을 회수했습니다`, variant: "success" });
        setRevokeTarget(null);
        await loadList();
      } else {
        // 🔴 사유를 삼키지 않는다 — "이미 회수됨"과 "입장 완료"는 조치가 다르다.
        addToast({ message: res.error ?? "회수하지 못했습니다", variant: "error" });
      }
    } catch (err: unknown) {
      addToast({
        message: err instanceof Error ? err.message : "회수하지 못했습니다",
        variant: "error",
      });
    } finally {
      setRevoking(null);
    }
  }

  /**
   * 재발송 — 행별 1건, 배너에서 일괄.
   *
   * 🔴 잘못 만들면 **중복 발송**이다. 손님이 초대권을 두 장 받고 알림톡은 회수할 수 없다.
   *    방어는 세 겹이다:
   *      ① 표시 조건 — `canResendInvitation` 이 이미 받은 행에서 버튼 자체를 감춘다
   *      ② 진행 중 잠금 — 누르는 즉시 비활성. 두 번 누르면 두 번 나간다
   *      ③ 성공 후 목록 재조회 — 옛 상태가 남아 있으면 주최자가 또 누른다
   *
   * ⚠️ 회수와 달리 **확인 다이얼로그를 두지 않는다.** 재발송은 되돌릴 수 있는 동작이 아니라
   *    "안 간 것을 다시 보내는" 복구 동작이고, 지금 발주처는 23시간째 막혀 있다.
   *    다이얼로그가 한 겹 더 있으면 정작 급할 때 손이 느려진다.
   */
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendingAll, setResendingAll] = useState(false);
  const resendBusy = resendingId !== null || resendingAll;

  /** 한 건 재발송. 성공 여부만 돌려준다(집계는 호출부가 한다). */
  const postResend = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetchWithAuth<{ success: boolean; error?: string }>(
        `/api/events/${eventId}/invitations/${id}`,
        { method: "POST", body: JSON.stringify({ action: "resend" }) },
      );
      return { ok: res.success === true, error: res.error };
    },
    [eventId],
  );

  async function doResend(target: Invitation) {
    if (resendBusy) return; // 재진입 가드 — 두 번 눌리면 두 번 나간다
    setResendingId(target.id);
    try {
      const r = await postResend(target.id);
      if (r.ok) {
        addToast({ message: `${target.recipientName} 초대권을 다시 보냈습니다`, variant: "success" });
        await loadList();
      } else {
        // 🔴 사유를 삼키지 않는다 — "이미 발송됨"과 "채널 미설정"은 조치가 다르다.
        addToast({ message: r.error ?? "재발송하지 못했습니다", variant: "error" });
      }
    } catch (err: unknown) {
      addToast({
        message: err instanceof Error ? err.message : "재발송하지 못했습니다",
        variant: "error",
      });
    } finally {
      setResendingId(null);
    }
  }

  /**
   * 막힌 건 전부 재발송.
   *
   * ⚠️ 대상은 **행별 버튼과 같은 판정**(`resendableIds`)에서 온다. 여기서 따로 거르면
   *    두 경로가 갈리고, 화면에 버튼이 없던 행까지 나갈 수 있다.
   */
  async function doResendAll() {
    if (resendBusy) return;
    const ids = resendableIds(rows);
    if (ids.length === 0) return;
    setResendingAll(true);
    try {
      let ok = 0;
      let failed = 0;
      let firstError: string | undefined;
      for (const id of ids) {
        try {
          const r = await postResend(id);
          if (r.ok) ok += 1;
          else {
            failed += 1;
            firstError ??= r.error;
          }
        } catch {
          failed += 1;
        }
      }
      addToast({
        message:
          failed === 0
            ? `${ok}건을 다시 보냈습니다`
            : `${ok}건 재발송 · ${failed}건 실패${firstError ? ` — ${firstError}` : ""}`,
        variant: failed === 0 ? "success" : "error",
      });
      await loadList();
    } finally {
      setResendingAll(false);
    }
  }

  /** 번호별 장수 — 표시 전용. 🔴 상한 판정에 쓰지 말 것(정본은 v2 의 CHECK+409). */
  const stagedCounts = useMemo(() => countByPhone(staged), [staged]);

  const canSend = staged.length > 0 && !sending;

  /**
   * @param force 배치 멱등을 **명시 해제**하고 다시 보낸다.
   *
   * 🔴 기본값 false 를 지키는 것이 계약이다. 켜면 같은 사람에게 초대권이 한 장 더 나가고
   *    알림톡은 회수할 수 없다 — 반드시 별도 확인을 거친 경로에서만 true 로 부른다.
   */
  async function submit(force = false) {
    // 🔴 재진입 가드 — 외부 발송(알림톡)이 걸린 동작이다. 두 번 눌리면 중복 발권·중복 발송.
    if (sending) return;
    setConfirmOpen(false);
    setForceConfirmOpen(false);
    setSending(true);
    setLastResult(null);
    try {
      const recipients = staged.map((r) => ({
        name: r.name,
        phone: r.phone,
        // 🔴 admissionDay 를 싣지 않는다(정책). 서버도 최종 관문에서 떨어낸다.
        admissionMode: (event?.admissionMode ?? "single") as "single" | "daypass" | "allpass",
      }));
      const res = await fetchWithAuth<{ success: boolean; data: BulkResult; error?: string }>(
        `/api/events/${eventId}/invitations/bulk`,
        { method: "POST", body: JSON.stringify({ recipients, ...(force ? { force: true } : {}) }) },
      );
      if (res.success) {
        setLastResult(res.data);
        // 🔴 재사용·처리중일 때 "N장 발권 완료" 는 거짓이다 — 아무것도 발급되지 않았다.
        //    단위도 "명" 이 아니라 "장" 이다(한 사람이 여러 장을 받을 수 있다).
        const blocked = Boolean(res.data.inProgress || res.data.replayed);
        if (res.data.inProgress) {
          addToast({ message: "같은 명단이 처리 중입니다", variant: "warning" });
        } else if (res.data.replayed) {
          addToast({ message: "이미 처리한 명단입니다 — 추가 발급 없음", variant: "warning" });
        } else {
          addToast({ message: `${res.data.issued}장 발권 완료 (발송 대기)`, variant: "success" });
        }
        // 🔴 막혔을 때는 명단을 **비우지 않는다**(2026-07-31). 종전엔 무조건 지워서,
        //    "이미 처리한 명단" 을 보고 다시 보내려면 붙여넣기부터 다시 해야 했다 —
        //    아래 "그래도 다시 보내기" 가 누를 대상 자체가 사라지는 것이다.
        if (!blocked) {
          setText("");
          setStaged([]);
        }
        void loadList();
      } else {
        addToast({ message: res.error ?? "대량 초대에 실패했습니다.", variant: "error" });
      }
    } catch {
      addToast({ message: "대량 초대에 실패했습니다.", variant: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">추가 도구</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">초대권 보내기</h2>
        <p className="mt-2 text-sm text-content-muted">
          입력한 휴대폰 번호의 카카오톡으로 초대권이 발송됩니다.
          <br />
          <span className="font-semibold">한 번호에 여러 장</span>을 보낼 수 있습니다(한 번호당 최대 {ADD_QTY_MAX}장) —
          한 명씩 추가에서 <span className="font-semibold">장수</span>를 고르거나,
          명단 붙여넣기에서는 보내려는 장수만큼 줄로 넣어주세요.
          <br />
          같은 명단을 다시 올리면 <span className="font-semibold">추가 발급되지 않습니다</span>
          (같은 파일을 두 번 올려 두 배로 나가는 것을 막습니다).
        </p>
      </div>

      <DispatchReadiness
        messaging={messaging}
        rows={rows}
        onResendAll={() => void doResendAll()}
        resending={resendingAll}
      />

      {/*
        🔴 주 작업(수신인 등록 → 목록 확인 → 발송)을 **한 화면**에 둔다.
        종전엔 준비상태(130px)+통계 4칸(110px)+미리보기가 상단을 먹어 발송 버튼이
        스크롤 밖으로 밀렸다. 넣고→확인하고→보내는 흐름이 한 화면에 안 들어왔다.
        통계는 아래 발송 추적 목록의 요약이므로 그쪽 머리로 옮겼다.
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-foreground">수신인 등록</CardTitle>
          {/* 🔴 미리보기는 처음 한 번 보면 되는 것 — 상시 노출로 280px 을 먹지 않게 접는다. */}
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>
            <Eye className="mr-1 size-3.5" />
            {showPreview ? "미리보기 닫기" : "알림톡 미리보기"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {showPreview ? (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <InvitationPreview
                eventTitle={event?.title || "행사명"}
                eventDate={
                  // 🔴 초대권 미리보기의 행사일 — 알림톡에 그대로 실리는 값이라
                  //    서버 시간대에 밀리면 손님이 하루 틀린 날짜를 받는다.
                  event?.startsAt ? formatDateKst(event.startsAt, "행사일자") : "행사일자"
                }
                venueName={event?.venue || "행사장"}
                channelId={messaging?.channelId ?? null}
              />
            </div>
          ) : null}

          {/* 🔴 두 입력 방식은 **택일**이다. 세로로 쌓아두면 서로 경쟁하고 화면만 길어진다. */}
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["one", "bulk"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setInputMode(m)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  inputMode === m ? "bg-card text-foreground shadow-sm" : "text-content-muted"
                }`}
              >
                {m === "one" ? "한 명씩 추가" : "명단 붙여넣기"}
              </button>
            ))}
          </div>

          {inputMode === "one" ? (
            <div className="space-y-2">
              {/* 🔴 지정일을 같은 줄에 둔다 — 별도 줄이면 "화면 전체 설정" 처럼 읽힌다.
                  실제로는 지금 추가하는 **이 한 명**의 입장일이다. */}
              <div className={`grid gap-2 sm:items-end ${collectsAdmissionDay ? "sm:grid-cols-[1fr_1fr_140px_100px_auto]" : "sm:grid-cols-[1fr_1fr_100px_auto]"}`}>
                <div className="space-y-1">
                  <Label htmlFor="one-name">이름</Label>
                  <Input id="one-name" value={oneName} placeholder="홍길동"
                    onChange={(e) => { setOneName(e.target.value); setOneError(null); }} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="one-phone">휴대폰 번호</Label>
                  <Input id="one-phone" value={onePhone} placeholder="01012345678" inputMode="numeric"
                    onChange={(e) => { setOnePhone(e.target.value); setOneError(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") addOne(); }} />
                </div>
                {/* 🔴 장수 — 같은 번호를 손으로 여러 번 입력하지 않게 한다(대표 요청 2026-07-31).
                    고른 만큼 목록에 줄이 생기므로, 무엇이 나갈지는 아래 목록에서 그대로 보인다.
                    ⚠️ 이 범위는 **입력칸의 경계**지 상한 판정이 아니다 — 정본은 v2 의 CHECK+409. */}
                <div className="space-y-1">
                  <Label htmlFor="one-qty">장수</Label>
                  <select id="one-qty" value={oneQty}
                    onChange={(e) => setOneQty(Number(e.target.value))}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                    {Array.from({ length: ADD_QTY_MAX }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}장</option>
                    ))}
                  </select>
                </div>
                <Button type="button" variant="outline" onClick={addOne}
                  disabled={!oneName.trim() || !onePhone.trim()}>
                  <Plus className="mr-1 size-4" />추가
                </Button>
              </div>
              {oneError ? <p role="alert" className="text-xs text-destructive">{oneError}</p> : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="bulk-recipients">
                한 줄에 한 명: 이름, 전화번호{collectsAdmissionDay ? ", 입장일" : ""}
              </Label>
              <Textarea
                id="bulk-recipients"
                rows={6}
                spellCheck={false}
                placeholder={bulkPlaceholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                엑셀·구글시트에서 복사해 붙여넣을 수 있습니다(콤마 또는 탭 구분).
              </p>

              {text.trim() ? (
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <p className="text-foreground">
                    유효 수신자 <span className="font-semibold text-primary">{parsed.recipients.length}</span>명
                    {parsed.errors.length > 0 ? (
                      <span className="ml-2 text-destructive">· 오류 {parsed.errors.length}건</span>
                    ) : null}
                  </p>
                  {parsed.errors.length > 0 ? (
                    <ul className="mt-2 max-h-24 space-y-1 overflow-auto text-xs text-destructive">
                      {parsed.errors.slice(0, 10).map((e) => (
                        <li key={e.line}>{e.line}번째 줄: {e.reason}</li>
                      ))}
                      {parsed.errors.length > 10 ? <li>… 외 {parsed.errors.length - 10}건</li> : null}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={addPasted}
                  disabled={parsed.recipients.length === 0 || parsed.errors.length > 0}>
                  <Plus className="mr-1 size-4" />
                  목록에 추가 ({parsed.recipients.length}명)
                </Button>
              </div>
            </div>
          )}

          {/* 날짜를 못 정하는 것이 실수가 아니라 정책임을 주최자에게 알린다. */}
          <p className="text-xs text-content-muted">{INVITATION_ADMISSION_NOTICE}</p>
        </CardContent>
      </Card>
        </div>

        {/* 오른쪽 — 넣으면서 쌓이는 게 보여야 한다(종전엔 스크롤을 내려야 보였다) */}
        <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-foreground">초대권 수신인 목록</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-sm text-content-muted">수신인 {staged.length}명</span>
            {staged.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStaged([])}>
                <RotateCcw className="mr-1 size-3.5" />초기화
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {staged.length === 0 ? (
            <p className="py-6 text-center text-sm text-content-muted">
              초대권 수신인을 등록해주세요.
            </p>
          ) : (
            <div className="max-h-72 overflow-auto rounded-lg border border-border">
              <table className="w-full">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left text-xs text-content-muted">
                    <th className="px-3 py-2">이름</th>
                    <th className="px-3 py-2">휴대폰 번호</th>
                    {collectsAdmissionDay ? <th className="px-3 py-2">입장일</th> : null}
                    <th className="px-3 py-2 text-right">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {staged.map((r, idx) => {
                    // 같은 번호가 여러 줄일 수 있다(1인 다장). 몇 장째인지 보여주지 않으면
                    // 주최자가 실수로 10줄 넣은 것을 알아채지 못한다.
                    const total = stagedCounts.get(r.phone.replace(/\D/g, "")) ?? 1;
                    const nth = staged.slice(0, idx + 1).filter((x) => x.phone.replace(/\D/g, "") === r.phone.replace(/\D/g, "")).length;
                    return (
                      // 🔴 key 에 번호만 쓰면 중복 줄이 같은 key 가 된다 — 인덱스를 함께 쓴다.
                      <tr key={`${r.phone}-${idx}`} className="border-t border-border">
                        <td className="px-3 py-2 text-sm text-foreground">
                          {r.name}
                          {total > 1 ? (
                            <span className="ml-2 text-xs text-content-muted">{nth}/{total}장</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-sm text-content-muted">{r.phone}</td>
                        {collectsAdmissionDay ? <td className="px-3 py-2 text-sm text-content-muted">{r.admissionDay ?? "-"}</td> : null}
                        <td className="px-3 py-2 text-right">
                          {/* 🔴 이 줄 하나만 지운다. 번호로 지우면 같은 번호 3줄이 다 사라진다. */}
                          <Button type="button" variant="ghost" size="sm" aria-label={`${r.name} ${nth}번째 삭제`}
                            onClick={() => setStaged((prev) => removeAt(prev, idx))}>
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {lastResult ? (
            <div
              className={
                lastResult.replayed || lastResult.inProgress
                  ? "rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-foreground"
                  : "rounded-lg border border-success/40 bg-success/5 p-3 text-sm text-foreground"
              }
            >
              {/* 🔴 같은 명단 재업로드 — 이 안내가 없으면 운영자는 "이름 고쳤는데 왜 안 바뀌지"
                  로 헤맨다. 지문에서 이름을 뺀 설계를 화면이 알려줘야 한다
                  (근거: lib/server/invitation-batch-key.ts 상단). */}
              {lastResult.inProgress ? (
                <>
                  <span className="font-semibold">같은 명단이 처리 중입니다.</span> 새로 발급된 초대권은
                  없습니다. 잠시 후 아래 목록에서 결과를 확인해주세요.
                </>
              ) : lastResult.replayed ? (
                <>
                  <span className="font-semibold">이미 처리한 명단입니다.</span> 새로 발급된 초대권은 없습니다
                  (앞서 {lastResult.issued}장 발급됨).
                  <p className="mt-1 text-xs text-muted-foreground">
                    번호와 입장 조건이 같으면 <span className="font-semibold">이름만 바꿔도 같은 명단</span>으로
                    봅니다. 같은 파일을 두 번 올려 초대권이 두 배로 나가는 것을 막기 위한 것입니다.
                  </p>
                  {/* 🔴 명시 해제 (2026-07-31). 종전엔 이 방어를 푸는 수단이 **아무 데도 없어서**
                      한번 막히면 7일을 기다리거나 명단을 억지로 흐트러뜨려야 했다.
                      자동으로 풀지 않는 이유: 원장을 지워도 알림톡이 취소되는 것은 아니다 —
                      나간 사실만 사라진 상태에서 자동 재발급하면 같은 사람에게 두 번 간다. */}
                  {staged.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={sending}
                        onClick={() => setForceConfirmOpen(true)}
                      >
                        그래도 다시 보내기
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        이미 받은 분에게 <span className="font-semibold">한 장이 더</span> 나갑니다.
                      </span>
                    </div>
                  ) : null}
                  {lastResult.batchFingerprint ? (
                    <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                      명단 식별자 {lastResult.batchFingerprint.slice(0, 12)}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  발권 {lastResult.issued}장
                  {lastResult.atLimit > 0 ? ` · 상한도달 ${lastResult.atLimit}건` : ""}
                  {lastResult.invalid > 0 ? ` · 번호오류 ${lastResult.invalid}건` : ""}
                  {lastResult.failed > 0 ? (
                    <span className="text-destructive"> · 실패 {lastResult.failed}건</span>
                  ) : null}
                  {lastResult.issued > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      알림톡 발송 대기열에 적재됐습니다. 아래 목록에서{" "}
                      <span className="font-semibold">발송됨</span> 으로 바뀌는지 확인해주세요.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button onClick={() => setConfirmOpen(true)} disabled={!canSend}>
              <Send className="mr-2 size-4" />
              {sending ? "발권 중..." : `초대권 보내기 (${staged.length}명)`}
            </Button>
          </div>
        </CardContent>
      </Card>
        </div>
      </div>

      {/* 발송 추적 목록 */}
      {loading ? (
        <div className="animate-pulse rounded-xl border border-border bg-card p-6"><div className="h-5 w-48 rounded bg-muted" /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="아직 배포한 초대권이 없습니다" description="위에서 수신인을 등록해 초대권을 보내세요." icon={Send} />
      ) : (
        <Card>
          {/* 🔴 통계는 이 목록의 **요약**이다. 보내기 전에 큰 숫자 4칸으로 상단을 먹을
              이유가 없어 여기로 옮겼다(상단 110px 회수). */}
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-foreground">발송 추적</CardTitle>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Stat icon={Users} label="발권" value={(summary.issued ?? 0) + (summary.sent ?? 0) + (summary.viewed ?? 0) + (summary.checked_in ?? 0)} />
              <Stat icon={Clock} label="발송 대기" value={summary.issued ?? 0} />
              <Stat icon={Eye} label="열람" value={summary.viewed ?? 0} />
              <Stat icon={LogIn} label="입장완료" value={summary.checked_in ?? 0} />
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-content-muted">
                  <th className="px-4 py-3">수신자</th>
                  <th className="px-4 py-3">전화번호</th>
                  {collectsAdmissionDay ? <th className="px-4 py-3">입장일</th> : null}
                  <th className="px-4 py-3">상태</th>
                  <th className="px-4 py-3">발권일</th>
                  <th className="px-4 py-3 text-right">재발송</th>
                  <th className="px-4 py-3 text-right">회수</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-sm text-foreground">{r.recipientName}</td>
                    <td className="px-4 py-3 text-sm text-content-muted">{r.phone ?? "-"}</td>
                    {collectsAdmissionDay ? <td className="px-4 py-3 text-sm text-content-muted">{r.admissionDay ?? "-"}</td> : null}
                    <td className="px-4 py-3">
                      <InvitationStatusCell row={r} />
                    </td>
                    <td className="px-4 py-3 text-xs text-content-muted">{formatDateShortKst(r.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {/*
                        🔴 **이미 받은 사람에게는 버튼을 노출하지 않는다.** 누르면 한 장 더 간다.
                           판정은 `canResendInvitation` 하나로만 한다 — 여기서 조건을 다시 적으면
                           배너 일괄 버튼과 갈린다.
                      */}
                      {canResendInvitation(r) ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={resendBusy}
                          aria-label={`${r.recipientName} 초대권 재발송`}
                          onClick={() => void doResend(r)}
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/*
                        🔴 회수는 **되돌릴 수 없다** — 보낸 링크가 즉시 죽고 티켓도 취소된다.
                           이미 회수됐거나 입장한 행은 애초에 못 누르게 한다(서버도 409 로 막는다).
                      */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={r.status === "revoked" || r.status === "checked_in" || revoking !== null}
                        aria-label={`${r.recipientName} 초대권 회수`}
                        onClick={() => setRevokeTarget(r)}
                      >
                        <Ban className="size-3.5 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/*
        🔴 회수 확인 — 되돌릴 수 없는 동작이므로 결과를 문구로 명시한다.
           `pending` 은 확인 버튼을 잠근다(더블클릭 방어).
      */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => { if (!next) setRevokeTarget(null); }}
        title="초대권 회수"
        description={
          revokeTarget
            ? `${revokeTarget.recipientName}(${revokeTarget.phone ?? "번호 없음"}) 님의 초대권을 회수합니다.\n` +
              "이미 보낸 초대 링크가 즉시 사용 불가가 되고 티켓도 취소됩니다. 되돌릴 수 없습니다."
            : ""
        }
        confirmText="회수"
        onConfirm={doRevoke}
        pending={revoking !== null}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="초대권 보내기"
        description={`수신인 ${staged.length}명에게 초대권을 발권하고 카카오톡 알림톡을 발송합니다. 계속할까요?`}
        confirmText="보내기"
        onConfirm={() => submit(false)}
        pending={sending}
      />

      {/* 🔴 멱등 해제 재발송 — 일반 발송과 문구를 **분리**한다. 같은 문구를 재사용하면
          "이미 받은 사람에게 한 장 더 간다" 는 핵심이 가려진다. */}
      <ConfirmDialog
        open={forceConfirmOpen}
        onOpenChange={setForceConfirmOpen}
        title="같은 명단을 다시 보냅니다"
        description={
          `이 명단 ${staged.length}명은 이미 처리됐습니다. 그래도 보내면 ` +
          `이미 초대권을 받은 분에게 한 장이 더 발급되고 알림톡이 다시 나갑니다. ` +
          `발송된 알림톡은 회수할 수 없습니다. 계속할까요?`
        }
        confirmText="그래도 다시 보내기"
        onConfirm={() => submit(true)}
        pending={sending}
      />
    </div>
  );
}

/** 인라인 통계 — 큰 카드 대신 한 줄에 붙는다. */
function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5 text-content-muted">
      <Icon className="size-3.5 text-primary" />
      <span className="text-xs">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}
