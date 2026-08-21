"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import DOMPurify from "isomorphic-dompurify";
import { MESSAGE_PURPOSES, type MessagePurpose } from "@/lib/notification/message-purpose";
import { adSmsFooter } from "@/lib/notification/legal-footer";
import { manualSendTemplateOptions } from "@/lib/notification/alimtalk-templates";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";
import { CHANNEL_LABELS } from "./message-labels";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface MessageComposerProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 발송/예약 성공 시 — 부모가 목록을 갱신한다. */
  onSent: () => void;
}

export function MessageComposer({ eventId, open, onOpenChange, onSent }: MessageComposerProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<"email" | "sms" | "alimtalk">("email");
  const [recipientFilter, setRecipientFilter] = useState<"all" | "checked_in" | "not_checked_in">("all");
  const [purchasedAfter, setPurchasedAfter] = useState("");
  const [purchasedBefore, setPurchasedBefore] = useState("");
  const [lotteryWon, setLotteryWon] = useState(false);
  const [purpose, setPurpose] = useState<MessagePurpose>("notice");
  const derivedAdvertising = channel !== "alimtalk" && (purpose === "promotion" || purpose === "sale");
  const [templateCode, setTemplateCode] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [sending, setSending] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [recipientLoading, setRecipientLoading] = useState(false);

  // B8: 제목/본문 입력 중 dirty
  const formDirty = open && (title.trim().length > 0 || body.trim().length > 0);
  useUnsavedChanges(formDirty);

  // 참석자 → 발송 브리지: ?compose=1&status=checked_in&lottery=1 로 진입 시 작성창 프리필.
  // (W3-MSG: CRM 등급 세그먼트 폐기 — tier= 파라미터 수용 제거. 호출부 실측 0.)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("compose") !== "1") return;
    onOpenChange(true);
    const st = q.get("status");
    if (st === "checked_in" || st === "not_checked_in") setRecipientFilter(st);
    if (q.get("lottery") === "1") setLotteryWon(true);
    // 프리필 후 URL 정리(뒤로가기 시 재오픈 방지).
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 작성 중 초안 autosave(localStorage) — 실수로 닫아도 복구.
  const draftKey = `pickket:msg-draft:${eventId}`;
  useEffect(() => {
    if (!open) return;
    if (!title && !body) return;
    const t = setTimeout(() => {
      try {
        // M-07: 수신자(필터/세그먼트)·예약·알림톡 템플릿까지 전부 저장한다.
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            title, body, channel, purpose,
            recipientFilter, purchasedAfter, purchasedBefore, lotteryWon,
            templateCode, scheduledAt,
          }),
        );
      } catch {
        /* 저장 실패 무시 */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [open, title, body, channel, purpose, recipientFilter, purchasedAfter, purchasedBefore, lotteryWon, templateCode, scheduledAt, draftKey]);

  // 작성창 열 때 저장된 초안이 있으면 복구(비어 있을 때만).
  function restoreDraft() {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as {
        title?: string; body?: string; channel?: typeof channel; purpose?: MessagePurpose;
        recipientFilter?: typeof recipientFilter;
        purchasedAfter?: string; purchasedBefore?: string; lotteryWon?: boolean;
        templateCode?: string; scheduledAt?: string;
      };
      if (!title && d.title) setTitle(d.title);
      if (!body && d.body) setBody(d.body);
      if (d.channel) setChannel(d.channel);
      if (d.purpose) setPurpose(d.purpose);
      if (d.recipientFilter) setRecipientFilter(d.recipientFilter);
      if (d.purchasedAfter) setPurchasedAfter(d.purchasedAfter);
      if (d.purchasedBefore) setPurchasedBefore(d.purchasedBefore);
      if (typeof d.lotteryWon === "boolean") setLotteryWon(d.lotteryWon);
      if (d.templateCode) setTemplateCode(d.templateCode);
      if (d.scheduledAt) setScheduledAt(d.scheduledAt);
      showSuccess("저장된 초안을 불러왔습니다");
    } catch {
      /* 파싱 실패 무시 */
    }
  }

  // 고급 세그먼트가 설정됐으면 segment 로, 아니면 recipientFilter(레거시)로 전송.
  function payloadTarget(): Record<string, unknown> {
    const advanced = Boolean(purchasedAfter) || Boolean(purchasedBefore) || lotteryWon;
    const base: Record<string, unknown> = { purpose };
    if (scheduledAt) base.scheduledAt = new Date(scheduledAt).toISOString();
    if (channel === "alimtalk" && templateCode) base.templateCode = templateCode;
    if (!advanced) return { ...base, recipientFilter };
    const seg: Record<string, unknown> = {};
    if (recipientFilter !== "all") seg.status = recipientFilter;
    if (lotteryWon) seg.lotteryWon = true;
    if (purchasedAfter) seg.purchasedAfter = new Date(`${purchasedAfter}T00:00:00+09:00`).toISOString();
    if (purchasedBefore) seg.purchasedBefore = new Date(`${purchasedBefore}T23:59:59+09:00`).toISOString();
    return { ...base, segment: seg };
  }

  // 본인 테스트발송 — 작성 중 메시지를 담당자 본인에게 1건 발송.
  async function sendTest() {
    setTestSending(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/messages/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          channel,
          purpose,
          ...(channel === "alimtalk" && templateCode ? { templateCode } : {}),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { data?: { to?: string }; error?: string };
      if (res.ok) showSuccess(`테스트 발송 완료 (${payload.data?.to ?? "본인"})`);
      else showError(payload.error ?? "테스트 발송에 실패했습니다");
    } finally {
      setTestSending(false);
    }
  }

  // 본문 편집 헬퍼(간이 리치에디터) — 선택영역 감싸기 / 커서 위치 삽입.
  function insertAtCursor(text: string) {
    const el = document.getElementById("message-body") as HTMLTextAreaElement | null;
    if (!el) { setBody((b) => b + text); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + text + body.slice(end));
  }
  function wrapSelection(pre: string, post: string) {
    const el = document.getElementById("message-body") as HTMLTextAreaElement | null;
    if (!el) { setBody((b) => b + pre + post); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + pre + body.slice(start, end) + post + body.slice(end));
  }

  // 미리보기 렌더 — 이메일은 HTML, SMS/알림톡은 평문. 서버 판정(derivedAdvertising) 기준 (광고) 표기 반영.
  const previewSubject = derivedAdvertising ? `(광고) ${title}` : title;
  const previewBody =
    derivedAdvertising && channel === "sms"
      ? `(광고)\n${body}${adSmsFooter()}`
      : body;

  /**
   * 🔴 수신자 수를 **확정한 뒤에** 확인창을 연다 (2026-07-30 감사).
   *
   * 종전엔 `setConfirmOpen(true)` 가 먼저였다. 그래서 dryRun 이 도는 동안 확인창이 이미 열려
   * 있고 [발송하기] 가 눌리는 상태였다 — **수신자가 몇 명인지 모르는 채 실발송**이 가능했다.
   * 이메일·SMS·알림톡은 되돌릴 수 없어서, 예상보다 훨씬 큰 대상에게 나가도 회수가 안 된다.
   *
   * `pending` prop 으로 막지 않은 이유: `pending` 은 ESC·바깥클릭·취소까지 함께 잠근다.
   * dryRun 에는 타임아웃이 없어서(별건) 응답이 안 오면 **사용자가 창에 갇힌다.**
   * 여는 시점을 늦추면 갇힘 없이 같은 목적을 달성한다.
   */
  async function openConfirm() {
    setRecipientCount(null);
    setRecipientLoading(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, channel, ...payloadTarget(), dryRun: true }),
      });
      if (res.ok) {
        const payload = (await res.json()) as { data?: { recipientCount?: number } };
        setRecipientCount(payload.data?.recipientCount ?? null);
      }
    } catch {
      // dryRun 실패 — recipientCount null 폴백(확인창 문구가 "선택한 수신자에게"로 떨어진다)
    } finally {
      setRecipientLoading(false);
      // dryRun 성공·실패 모두 여기서 연다. 실패해도 발송 자체를 막지는 않는다
      // (수신자 수 표시는 보조 정보고, 대상 필터는 서버가 다시 계산한다).
      setConfirmOpen(true);
    }
  }

  async function sendMessage() {
    setSending(true);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, channel, ...payloadTarget() }),
      });
      if (!response.ok) {
        showError("메시지 발송에 실패했습니다");
        return;
      }
      onOpenChange(false);
      setTitle("");
      setBody("");
      setChannel("email");
      setRecipientFilter("all");
      setPurchasedAfter("");
      setPurchasedBefore("");
      setLotteryWon(false);
      setPurpose("notice");
      setTemplateCode("");
      setScheduledAt("");
      try { localStorage.removeItem(draftKey); } catch { /* noop */ }
      onSent();
      showSuccess(scheduledAt ? "메시지가 예약되었습니다" : "메시지가 발송 대기열에 추가되었습니다");
    } finally {
      setSending(false);
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 (S3).
  // 종전엔 `setConfirmOpen(false); void sendMessage()` 라 **발송이 끝나기 전에 확인창이
  // 닫혔다.** 실발송은 이미 나갔는데 화면은 되돌아온 것처럼 보여, 안 나간 줄 알고 다시
  // 누를 수 있었다. 이제 끝난 뒤에 닫는다 — 실패하면 창이 남아 재시도할 수 있다.
  const sendAction = useConfirmAction(async () => {
    await sendMessage();
    setConfirmOpen(false);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>메시지 보내기</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3">
              <Button size="sm" variant="ghost" onClick={restoreDraft}>
                초안 불러오기
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="message-title">제목</Label>
              <Input id="message-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>채널</Label>
              <RadioGroup value={channel} onValueChange={(value: "email" | "sms" | "alimtalk") => setChannel(value)} className="space-y-2">
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="email" /> 이메일</label>
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="sms" /> SMS</label>
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="alimtalk" /> 카카오 알림톡</label>
              </RadioGroup>
            </div>
            {channel === "alimtalk" ? (
              <div className="space-y-1">
                <Label htmlFor="alimtalk-template" className="text-xs text-content-subtle">알림톡 승인 템플릿</Label>
                <select
                  id="alimtalk-template"
                  value={templateCode}
                  onChange={(e) => setTemplateCode(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">템플릿 선택 (미선택 시 배치 발송 불가)</option>
                  {/*
                    🔴 선택지를 **레지스트리에서 만든다.** 손으로 적던 시절 5개 중 나갈 수
                       있는 것이 0개였다(2개는 코드 오타, 3개는 언더바라 NCP 등록 자체가 불가).
                       주최자가 무엇을 고르든 실패하는 화면이었다.
                  */}
                  {manualSendTemplateOptions().map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-content-muted">본문은 카카오 승인 템플릿과 일치해야 하며, 알림톡은 정보성만 허용됩니다.</p>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>수신 대상</Label>
              <RadioGroup value={recipientFilter} onValueChange={(value: "all" | "checked_in" | "not_checked_in") => setRecipientFilter(value)} className="space-y-2">
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="all" /> 전체</label>
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="checked_in" /> 체크인 완료</label>
                <label className="flex items-center gap-3 text-sm text-content-subtle"><RadioGroupItem value="not_checked_in" /> 미체크인</label>
              </RadioGroup>
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
              <Label className="text-xs text-content-subtle">세그먼트 (선택) — 설정 시 위 대상과 함께 좁혀집니다</Label>
              {/* W3-MSG: "CRM 등급" 세그먼트 제거. 등급을 부여하는 CRM 관리 화면이 이미
                  삭제돼 crm_contacts 는 writer 0·행 0 이었고, 이 버튼으로 무엇을 고르든
                  수신자 0명(조용한 무발송)이 되던 자리다. 서버도 crmTiers/crmTags 를 400 으로
                  거부한다. */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-content-subtle">구매일 이후</p>
                  <input type="date" value={purchasedAfter} onChange={(e) => setPurchasedAfter(e.target.value)}
                    aria-label="구매일 이후"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground" />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-content-subtle">구매일 이전</p>
                  <input type="date" value={purchasedBefore} onChange={(e) => setPurchasedBefore(e.target.value)}
                    aria-label="구매일 이전"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-content-subtle">
                <input type="checkbox" checked={lotteryWon} onChange={(e) => setLotteryWon(e.target.checked)} />
                추첨 당첨자에게만 (낙첨자는 티켓이 없어 이 세그먼트로 도달 불가)
              </label>
              <p className="text-[11px] text-content-muted">수신거부·블랙리스트 고객은 자동 제외됩니다. 광고성 발송은 (광고)표기·수신동의가 적용됩니다.</p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="message-purpose" className="text-xs text-content-subtle">발송 목적</Label>
                <select
                  id="message-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value as MessagePurpose)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {MESSAGE_PURPOSES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label} ({p.type === "advertising" ? "광고성" : "정보성"})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-content-muted">
                  {derivedAdvertising
                    ? "광고성 — 수신동의·(광고)표기·야간(21~08)가드가 적용됩니다."
                    : "정보성 — 수신거부만 존중되며 거래 안내로 발송됩니다."}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="message-scheduled" className="text-xs text-content-subtle">예약 발송 (선택)</Label>
                <input
                  id="message-scheduled"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="message-body">본문</Label>
                <div className="flex items-center gap-1">
                  {channel === "email" ? (
                    <>
                      <button type="button" onClick={() => wrapSelection("<b>", "</b>")}
                        className="rounded border border-border px-2 py-0.5 text-xs font-bold text-foreground hover:bg-bg-subtle">B</button>
                      <button type="button" onClick={() => wrapSelection("<a href=\"https://\">", "</a>")}
                        className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">링크</button>
                      <button type="button" onClick={() => insertAtCursor("\n{이름}")}
                        className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">{"{이름}"}</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => insertAtCursor("{이름}")}
                      className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">{"{이름}"}</button>
                  )}
                  <button type="button" onClick={() => setShowPreview((v) => !v)}
                    className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">
                    {showPreview ? "편집" : "미리보기"}
                  </button>
                </div>
              </div>
              {showPreview ? (
                <div className="rounded-lg border border-border bg-background p-3 text-sm">
                  {previewSubject ? <p className="mb-2 font-semibold text-foreground">{previewSubject}</p> : null}
                  {channel === "email" ? (
                    <div className="prose prose-sm max-w-none text-foreground" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewBody || "<p class='text-content-subtle'>본문 미리보기</p>") }} />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-foreground">{previewBody || "본문 미리보기"}</pre>
                  )}
                  <p className="mt-2 text-[11px] text-content-muted">{"{이름}"}은 수신자별 이름으로 치환됩니다.</p>
                </div>
              ) : (
                <Textarea id="message-body" rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
              )}
            </div>
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={() => void sendTest()} disabled={testSending || !title.trim() || !body.trim()}>
              {testSending ? "테스트 발송 중…" : "본인에게 테스트"}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
              {/* recipientLoading 도 잠근다 — 수신자 확인 중 재클릭하면 dryRun 이 중복으로 나간다. */}
              <Button
                onClick={() => void openConfirm()}
                disabled={sending || recipientLoading || !title.trim() || !body.trim()}
              >
                {sending ? "발송 중…" : recipientLoading ? "수신자 확인 중…" : scheduledAt ? "예약" : "발송"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        title="메시지를 발송하시겠습니까?"
        description={
          recipientLoading
            ? "수신자 확인 중…"
            : recipientCount !== null
              ? `${recipientCount}명에게 ${CHANNEL_LABELS[channel] ?? channel}으로 발송합니다. 발송 후 취소할 수 없습니다.`
              : `선택한 수신자에게 ${CHANNEL_LABELS[channel] ?? channel}으로 발송합니다. 발송 후 취소할 수 없습니다.`
        }
        confirmText="발송하기"
        pending={sendAction.pending}
        onConfirm={sendAction.run}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setConfirmOpen(false);
            setRecipientCount(null);
          }
        }}
      />
    </>
  );
}
