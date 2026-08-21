"use client";

import { AlertTriangle, CheckCircle2, RotateCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resendableIds, type ResendCandidate } from "@/lib/invitations/resend-policy";
import { classifyDispatch, type DispatchRow } from "@/lib/invitations/dispatch-state";

export interface MessagingReadiness {
  channelId: string | null;
  /** 채널 ID 설정값 형식이 온전한가. false 면 보정해 보내더라도 설정을 고쳐야 한다. */
  channelIdOk?: boolean;
  channelIdMessage?: string | null;
  templateCode: string;
  alimtalkReady: boolean;
  smsFallbackReady: boolean;
}

/** 발권됐지만 아직 발송되지 않은(=대기열) 건이 이 시간을 넘기면 발송이 멈춘 것으로 본다. */
const STALL_MINUTES = 10;

export interface DispatchStall {
  /** 경고를 띄울 것인가 — 누락이 있거나, 대기가 너무 오래됐다. */
  stalled: boolean;
  /**
   * 🔴 **확정 누락** — 큐 행이 없거나, 큐는 끝났는데 원장에 발송 기록이 없다.
   *    시간과 무관하게 즉시 경고한다. 기다린다고 나가지 않는다.
   */
  missingCount: number;
  /** 큐에서 정상 대기 중인 건수. */
  waitingCount: number;
  /** 가장 오래 기다린 대기 건의 경과(분). */
  waitingOldestMinutes: number;
  /** 대기가 STALL_MINUTES 를 넘겼나 — 크론이 멈췄을 수 있다. */
  waitingStalled: boolean;
}

/**
 * **언제부터 기다렸나** — 대기 경과를 재는 기준 시각.
 *
 * 🔴 2026-08-04 실사고: 23시간 막혀 있던 5건에 재발송을 눌러 **실제로 발송까지 됐는데**
 *    (큐 queued→sent · epoch 0→1) 배너는 「1470분째 대기」 그대로였다.
 *    대기 경과를 **초대권 생성 시각**으로 재고 있었기 때문이다.
 *
 *    어제 발급된 초대권을 방금 다시 큐에 넣으면 **대기 시간은 0분이지 24시간이 아니다.**
 *    ⚠️ 주최자는 "안 먹혔나" 하고 한 번 더 누른다 — 그러면 손님이 두 장 받는다.
 *    알림톡은 회수할 수 없다.
 *
 * ⚠️ 큐 시각이 없으면(v2 구버전·큐 없는 행) **종전대로 초대권 생성 시각으로 되돌아간다.**
 *    2026-07-28 크론 사고의 방어선을 잃지 않기 위해서다.
 */
function waitingSince(row: { createdAt: string } & DispatchRow): string {
  const q = row.dispatchUpdatedAt;
  return typeof q === "string" && q.trim() !== "" ? q : row.createdAt;
}

/**
 * 발송이 실제로 나가고 있는지 판정한다.
 *
 * 🔴 발송은 1분 주기 크론이 대기열을 비우며 일어난다. 그 크론이 서버에 등록돼 있지
 *    않으면 **대기열에만 쌓이고 아무것도 나가지 않는다**(2026-07-28 실측: crontab
 *    14줄 중 dispatch-invitations 0건). 화면은 "발권 완료" 로 보이고 주최자는 모른다.
 *
 * ## 🔴 두 갈래를 따로 센다 (2026-08-04)
 * 종전엔 `status === "issued"` 를 전부 「멈춤」으로 셌다. 그래서 **큐에서 정상적으로
 * 순서를 기다리는 건까지** 멈춤으로 보였다. 이제 큐 상태가 오므로 가른다:
 * ```
 * 누락  큐에 없다 / 큐는 끝났는데 발송 기록이 없다   → 시간 무관 즉시 경고
 * 대기  큐에서 순서를 기다린다                      → STALL_MINUTES 넘을 때만 경고
 * ```
 *
 * ⚠️ **좁히면서 정상 대기가 오래 걸리는 경우를 놓치면 안 된다.** v2 가 큐 정보를 안 주는
 *    구버전에서는 모든 미발송이 `waiting` 으로 분류되므로, 이 함수는 옛 동작(10분 넘으면
 *    경고)을 그대로 유지한다 — 2026-07-28 의 방어선이 사라지지 않는다.
 */
export function detectStalledDispatch(
  rows: Array<{ status: string; createdAt: string } & DispatchRow>,
  now: number = Date.now(),
): DispatchStall {
  const views = rows.map((r) => ({ row: r, view: classifyDispatch(r) }));

  const missingCount = views.filter((v) => v.view.kind === "missing").length;
  const waiting = views.filter((v) => v.view.kind === "waiting");

  const oldest = waiting.reduce((min, v) => {
    const t = Date.parse(waitingSince(v.row));
    return Number.isNaN(t) ? min : Math.min(min, t);
  }, Number.POSITIVE_INFINITY);

  // 날짜를 하나도 못 읽으면 대기 경과를 단정하지 않는다 — 거짓 경보는 진짜 경보를 무디게 한다.
  const waitingOldestMinutes = Number.isFinite(oldest) ? Math.floor((now - oldest) / 60_000) : 0;
  const waitingStalled = Number.isFinite(oldest) && waitingOldestMinutes >= STALL_MINUTES;

  return {
    stalled: missingCount > 0 || waitingStalled,
    missingCount,
    waitingCount: waiting.length,
    waitingOldestMinutes,
    waitingStalled,
  };
}

/**
 * 🔴 정상일 때는 **한 줄**, 문제가 있을 때만 펼친다.
 *
 * 종전엔 정상 항목과 경고 항목이 **같은 크기 카드 3개**로 상단 130px 을 상시 차지했다.
 * 확인할 게 없는 항목이 자리를 먹으면 정작 주 작업(수신인 등록·발송)이 화면 밖으로
 * 밀린다. 문제는 크게, 정상은 작게 — 눈이 갈 곳을 화면이 정해줘야 한다.
 *
 * ⚠️ 접는다고 감추는 게 아니다. 경고·오류는 **접힌 줄에서도 그대로 보인다**(2026-07-29
 *    실사고: 형식이 깨진 채널 ID 를 초록불로 보여줘 발견이 늦었다).
 */
export function DispatchReadiness({
  messaging,
  rows,
  onResendAll,
  resending = false,
}: {
  messaging: MessagingReadiness | null;
  rows: Array<{ status: string; createdAt: string } & ResendCandidate & DispatchRow>;
  /** 막힌 건을 전부 다시 보낸다. 없으면 버튼을 그리지 않는다(구형 호출부 보호). */
  onResendAll?: () => void;
  /** 진행 중 — 🔴 버튼 비활성의 근거. 두 번 누르면 두 번 나간다. */
  resending?: boolean;
}) {
  if (!messaging) return null;
  const stall = detectStalledDispatch(rows);
  const resendableCount = resendableIds(rows.map((r, i) => ({ ...r, id: String(i) }))).length;
  const channelOk = messaging.alimtalkReady && messaging.channelIdOk !== false;
  const channelText = channelOk
    ? messaging.channelId ?? "연결됨"
    : messaging.channelIdMessage ??
      (messaging.alimtalkReady ? "채널 설정을 확인해주세요" : "미설정 — 실제 발송되지 않습니다");

  return (
    <div className="space-y-2">
      {/* 한 줄 요약 — 정상은 조용히, 경고는 눈에 띄게 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <span className="text-xs font-semibold text-content-muted">발송 준비</span>
        <InlineState ok={channelOk} label="알림톡" text={channelText} />
        <InlineState ok label="템플릿" text={messaging.templateCode} />
        {/* 🔴 문자 대체 배지 제거 (2026-08-10 대표 지시) — 화면에 상시 노출되니
            발주처·스태프 문의만 늘었다. **사실은 그대로다**: SENS_SMS_FROM 이 없으면
            카톡 미사용자는 초대권을 받지 못하고, 그 미도달은 화면 어디에도 안 뜬다.
            근본 해결은 NCP 발신번호 등록 후 env 한 줄이다. 되살릴 땐 여기다. */}
      </div>

      {stall.stalled ? (
        <div
          role="alert"
          className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            {/*
              🔴 「누락」과 「오래 대기」는 다른 사건이다.
                 누락은 기다려도 안 나간다 — 재발송이 유일한 길이다.
                 오래 대기는 크론이 멈춘 신호다 — 재발송해도 같은 큐에 다시 쌓인다.
              ⚠️ 두 문구를 하나로 뭉치면 주최자가 무엇을 해야 할지 못 정한다.
            */}
            <p className="font-semibold text-destructive">
              {stall.missingCount > 0
                ? `발송이 누락됐습니다 — ${stall.missingCount}건이 대기열에 없습니다`
                : `발송이 멈춰 있습니다 — ${stall.waitingCount}건이 ${stall.waitingOldestMinutes}분째 대기 중`}
            </p>
            {stall.missingCount > 0 && stall.waitingStalled ? (
              <p className="mt-0.5 text-xs text-destructive">
                이와 별개로 {stall.waitingCount}건이 {stall.waitingOldestMinutes}분째 대기 중입니다.
              </p>
            ) : null}
            {/*
              🔴 내부 크론 이름(dispatch-invitations)을 발주처에 보여주고 "우리한테 연락하라"로
                 끝내던 문구였다. 화면에서 할 수 있는 일이 0 이었다 — 재발송 API 는 이미 있었는데
                 버튼만 없었다. 지금은 **할 수 있는 행동**을 먼저 말한다.
            */}
            <p className="mt-1 text-xs text-content-muted">
              발권은 됐지만 알림톡이 나가지 않고 있습니다. 수신자는 아직 아무것도 받지
              못한 상태입니다.
              {resendableCount > 0
                ? " 아래 「다시 보내기」를 누르면 재발송됩니다. 눌러도 계속 멈춰 있으면 고객센터로 알려주세요."
                : " 계속 이 상태가 유지되면 고객센터로 알려주세요."}
            </p>
            {onResendAll && resendableCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                // 🔴 연타 방지 — 누르는 즉시 비활성. 두 번 누르면 초대권이 두 장 나간다.
                disabled={resending}
                onClick={onResendAll}
              >
                <RotateCcw className={`size-3.5 ${resending ? "animate-spin" : ""}`} />
                {resending ? "다시 보내는 중…" : `막힌 ${resendableCount}건 다시 보내기`}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 한 줄 안의 개별 상태 — 정상은 회색, 경고는 색으로 눈에 띈다. */
function InlineState({
  ok,
  label,
  text,
  warnOnly = false,
}: {
  ok: boolean;
  label: string;
  text: string;
  warnOnly?: boolean;
}) {
  const Icon = ok ? CheckCircle2 : warnOnly ? AlertTriangle : XCircle;
  const tone = ok ? "text-content-muted" : warnOnly ? "text-warning" : "text-destructive";
  return (
    <span className={`flex items-center gap-1 ${tone} ${ok ? "" : "font-medium"}`}>
      <Icon className="size-3.5 shrink-0" />
      <span className="text-xs">{label}</span>
      <span className="text-xs">{text}</span>
    </span>
  );
}
