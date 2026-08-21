/**
 * 입장 후 티켓 탭 — **QR 을 계속 보여준다.**
 *
 * 🔴 2026-08-19 대표 확정으로 전제가 바뀌었다. 종전 주석은 "하루 1회 입장이라 QR 을
 *    감춘다"였는데, 실제 운영은 **종일 입장(재입장 자유) + 경품추첨**이다.
 *    감추면 점심 먹고 나갔다 온 손님이 게이트에서 QR 을 못 내민다.
 *
 * ⚠️ 재입장은 서버가 `reentry_ok` 로 정상 처리한다(기념품만 첫 입장에 준다).
 *    화면이 막을 일이 아니다 — 판정은 게이트가 한다.
 * ⚠️ 경품번호는 추첨 때 스태프가 육안 확인하므로 **크게** 노출한다.
 */
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

import { RotatingTicketQR } from "../rotating-ticket-qr";
import { OrderTicketSwitcher } from "../order-ticket-switcher";
import type { OrderTicketItem } from "@/lib/tickets/order-siblings";

export interface AdmittedTicketPanelProps {
  ticketNumber: string;
  eventTitle: string;
  attendeeName: string | null;
  gradeLabel: string | null;
  scheduleText: string | null;
  venueText: string | null;
  raffleNumber: number | null;
  /** 서버가 발급한 초기 QR 이미지. 없으면 QR 을 안 그린다(사용 불가 티켓). */
  qrImage?: string | null;
  /** 딥링크 토큰 — 초대권·구매링크 손님의 QR 갱신에 필요하다. */
  qrAccessToken?: string | null;
  /**
   * 🔴 같은 주문의 형제 티켓 (2026-08-20 현장).
   *
   * 입장 후 화면에도 있어야 한다 — 주중권+주말권을 함께 산 손님이 한 장을 찍으면
   * 이 패널로 바뀌는데, 여기 전환 줄이 없어 **나머지 티켓으로 갈 길이 사라졌다**.
   */
  orderTickets?: OrderTicketItem[];
}

export function AdmittedTicketPanel({
  ticketNumber,
  eventTitle,
  attendeeName,
  gradeLabel,
  scheduleText,
  venueText,
  raffleNumber,
  qrImage,
  qrAccessToken,
  orderTickets,
}: AdmittedTicketPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 p-3">
        <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <p className="text-sm font-bold text-success">입장 완료</p>
          <p className="text-xs text-content-subtle">
            종일 입장입니다. 나갔다 다시 들어오실 때도 이 QR 을 보여주세요.
          </p>
        </div>
      </div>

      {/*
        🔴 입장 후에도 QR 을 남긴다 (2026-08-19).
           종일 입장이라 재입장 때 다시 필요하고, 경품추첨에도 티켓을 제시한다.
           감추면 점심 먹고 온 손님이 게이트에서 아무것도 못 내민다.
      */}
      {qrImage ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <RotatingTicketQR
            ticketNumber={ticketNumber}
            initialImage={qrImage}
            accessToken={qrAccessToken ?? null}
          />
        </div>
      ) : null}

      {orderTickets && orderTickets.length > 1 ? (
        <OrderTicketSwitcher items={orderTickets} />
      ) : null}

      {/* 추첨 때 스태프가 육안으로 본다 — 목록 안에 묻지 않고 크게 낸다. */}
      {raffleNumber != null ? (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-center">
          <p className="text-xs text-content-muted">경품 응모번호</p>
          <p className="text-2xl font-bold tabular-nums text-primary">{raffleNumber}</p>
        </div>
      ) : null}

      <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-sm">
        <Row label="행사" value={eventTitle} />
        {attendeeName ? <Row label="이름" value={attendeeName} /> : null}
        {gradeLabel ? (
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <dt className="shrink-0 text-content-muted">권종</dt>
            <dd>
              <Badge variant="secondary">{gradeLabel}</Badge>
            </dd>
          </div>
        ) : null}
        {scheduleText ? <Row label="일정" value={scheduleText} /> : null}
        {venueText ? <Row label="장소" value={venueText} /> : null}
        <Row label="티켓번호" value={ticketNumber} mono />
      </dl>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <dt className="shrink-0 text-content-muted">{label}</dt>
      <dd className={`min-w-0 text-right text-content-default ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
