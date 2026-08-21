"use client";

import { Badge } from "@/components/ui/badge";
import {
  classifyDispatch,
  dispatchLabel,
  needsAttention,
  type DispatchRow,
} from "@/lib/invitations/dispatch-state";

/** 원장 상태 라벨 — 발송이 끝난 뒤의 표시에만 쓴다. */
const STATUS_LABELS: Record<string, string> = {
  issued: "발권됨",
  sent: "발송됨",
  viewed: "열람됨",
  checked_in: "입장완료",
  failed: "실패",
  revoked: "회수됨",
};

function ledgerVariant(status: string): "default" | "secondary" | "success" | "info" | "destructive" {
  switch (status) {
    case "checked_in": return "success";
    case "viewed": return "info";
    case "sent": return "default";
    case "failed": return "destructive";
    case "revoked": return "secondary";
    default: return "secondary";
  }
}

/**
 * 🔴 「발권됨」 하나에 성격이 다른 둘이 섞여 있던 것을 가른다 (2026-08-04).
 *
 * ```
 * 발송 대기   큐에서 순서를 기다린다        회색 — 정상
 * 발송 중     워커가 지금 보내고 있다        회색 — 손대지 않는다
 * 🔴 발송 누락 큐에 없거나, 큐는 끝났는데     빨강 — 재발송이 필요하다
 *             원장에 발송 시각이 없다
 * 발송 실패   사유를 **그대로** 보여준다      빨강
 * ```
 *
 * ⚠️ 실패 사유를 「실패」로 뭉개면 안 된다. `알림톡 미도달(3019): 톡유저가 아님` 같은
 *    사유를 봐야 주최자가 **문자로 대체 발송할지**를 정할 수 있다.
 */
export function InvitationStatusCell({ row }: { row: DispatchRow }) {
  const view = classifyDispatch(row);
  const label = dispatchLabel(view);

  // 발송이 끝난 뒤(발송됨·열람·입장·회수)는 원장 상태를 그대로 쓴다.
  // 🔴 「보냈다」와 「그 사람에게 보냈다」는 다르다 (2026-08-12 실사고).
  //    양도 뒤 옛 번호로 나가면 상태는 「발송됨」인데 손님은 못 받았다.
  //    원장 상태를 그대로 쓰면 주최자가 정상으로 읽고 지나간다 — 먼저 말한다.
  if (row.dispatchStale === true) {
    return (
      <>
        <Badge variant="destructive">재발송 필요</Badge>
        <span className="ml-2 text-xs text-destructive">이전 수신자에게 발송되었습니다</span>
      </>
    );
  }

  if (!label) {
    return <Badge variant={ledgerVariant(row.status)}>{STATUS_LABELS[row.status] ?? row.status}</Badge>;
  }

  return (
    <>
      <Badge variant={needsAttention(view) ? "destructive" : "secondary"}>{label}</Badge>
      {view.kind === "failed" && view.reason ? (
        // 사유는 v2 가 준 문자열 그대로 — 우리가 요약하지 않는다.
        <span className="ml-2 text-xs text-destructive">{view.reason}</span>
      ) : null}
      {view.kind === "missing" ? (
        <span className="ml-2 text-xs text-destructive">
          {view.why === "not_queued"
            ? "발송 대기열에 등록되지 않았습니다"
            : "발송 처리는 끝났는데 발송 기록이 없습니다"}
        </span>
      ) : null}
    </>
  );
}
