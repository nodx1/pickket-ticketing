import Image from "next/image";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { eventPagePath } from "@/lib/public/event-path";
import { OFFLINE_PAYMENT_DEADLINE_TEXT, bankInfoFromEnv } from "@/lib/checkout/offline-payment";
import { CheckCircle2, Clock } from "lucide-react";
import { notFound } from "next/navigation";
import { ShareButtons } from "../../_components/share-buttons";
import { CheckoutProgress } from "../_components/checkout-progress";
import { Card, CardContent } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";
import { generateQRDataURL } from "@/lib/qrCode";
import { getPublicOrderCompletion } from "@/lib/server/events";
import { dayGuideLines, primaryCta } from "@/lib/checkout/completion-actions";
import { CompletionActionsBlock } from "./_components/completion-actions-block";

/** 입금 계좌 안내 — NEXT_PUBLIC_* 은 빌드 시각 고정이라 모듈 스코프에서 1회 평가한다. */
const bankInfo = bankInfoFromEnv();

export default async function CheckoutCompletePage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<{ orderId?: string }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);
  const eventHref = eventPagePath(eventSlug);
  const { orderId } = await searchParams;

  if (!orderId) {
    notFound();
  }

  const order = await getPublicOrderCompletion(orderId, eventSlug);
  if (!order) {
    notFound();
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  // ⚠️ 공유 URL 도 인코딩된 경로를 쓴다 — 이 대회 슬러그가 한글이라
  //    (`bc카드한경-klpga-챔피언십`) 날것으로 보내면 받는 쪽에서 링크가 깨진다.
  const shareUrl = `${appUrl}${eventHref ?? "/"}`;

  // 무통장입금 입금대기: 구매자 self-complete 로 확정되지 않고 주최자 입금확정 전까지 pending 이다
  // (감사 P0-F). 이 상태에서는 "예약 완료"가 아니라 "입금 대기"로 안내하고 QR/티켓을 노출하지 않는다.
  const isAwaitingDeposit =
    String(order.status) === "pending" && order.paymentMethod === "bank_transfer";

  const qrImage =
    !isAwaitingDeposit && order.ticketNumber
      ? await generateQRDataURL(String(order.ticketNumber))
      : null;

  // 🔴 상태에 따라 갈리는 판정은 **여기 한 곳**에서만 한다(`lib/checkout/completion-actions`).
  //    JSX 안에 흩어 놓으면 한쪽만 고쳐진다 — 무통장 화면이 그래서 스스로와 모순돼 있었다.
  const cta = primaryCta({
    awaitingDeposit: isAwaitingDeposit,
    ticketNumber: order.ticketNumber != null ? String(order.ticketNumber) : null,
    hasBankInfo: bankInfo.ok,
  });
  const guideLines = dayGuideLines(isAwaitingDeposit);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <CheckoutProgress current={4} />
      <div className="mx-auto mt-6 max-w-2xl">
        <Card className="border-border bg-card/95">
          <CardContent className="space-y-6 p-8 text-center">
            <div
              className={`mx-auto flex size-20 items-center justify-center rounded-full ${
                isAwaitingDeposit ? "bg-primary/15 text-primary" : "bg-success/20 text-success"
              }`}
            >
              {isAwaitingDeposit ? <Clock className="size-10" /> : <CheckCircle2 className="size-10" />}
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.24em] text-primary">
                {isAwaitingDeposit ? "awaiting deposit" : "checkout complete"}
              </p>
              <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">
                {isAwaitingDeposit ? "예약이 접수되었습니다" : "예약이 완료되었습니다!"}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">{String(order.eventTitle)}</p>
              {isAwaitingDeposit ? (
                <p className="mt-2 text-sm font-medium text-primary">
                  입금이 확인되면 티켓이 발급됩니다. 아직 결제가 완료된 것이 아닙니다.
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-border bg-muted p-5 text-left">
              <p className="text-sm text-muted-foreground">주문번호</p>
              <p className="mt-2 text-xl font-bold text-foreground">{String(order.orderNumber)}</p>
              <p className="mt-4 text-sm text-muted-foreground">{isAwaitingDeposit ? "입금 예정 금액" : "결제금액"}</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatKRW(Number(order.totalAmount ?? 0))}</p>
              {order.paymentMethod === "bank_transfer" ? (
                <div className="mt-4 rounded-lg border border-primary/20 bg-primary/10 p-4 text-sm text-muted-foreground">
                  {/*
                    🔴 자리값 폴백 제거 (2026-07-30). 종전 `?? "123-456-789012"` 는
                       env 가 **빈 문자열**인 prod 에서 폴백조차 걸리지 않아 빈칸이 나갔고,
                       걸렸다면 **남의 계좌번호처럼 보이는 값**을 노출했다.
                       기한 문구는 서버 계산과 같은 상수에서 온다(하드코딩 금지).
                  */}
                  {bankInfo.ok ? (
                    <>
                      <p className="font-semibold text-foreground">아래 계좌로 입금해 주세요</p>
                      <p className="mt-2">{bankInfo.info.bankName} {bankInfo.info.account}</p>
                      <p>예금주 {bankInfo.info.holder}</p>
                    </>
                  ) : (
                    <p className="font-semibold text-foreground">
                      입금 계좌는 주최자에게 문의해 주세요
                    </p>
                  )}
                  <p className="mt-2">{OFFLINE_PAYMENT_DEADLINE_TEXT}</p>
                </div>
              ) : null}
            </div>

            {qrImage ? (
              <div className="space-y-3">
                <Image
                  src={qrImage}
                  alt="티켓 QR 코드"
                  width={208}
                  height={208}
                  className="mx-auto rounded-lg bg-card p-4"
                />
                <p className="text-sm text-muted-foreground">{String(order.ticketNumber)}</p>
              </div>
            ) : null}

            <CompletionActionsBlock
              cta={cta}
              bankAccount={bankInfo.ok ? bankInfo.info.account : null}
              eventHref={eventHref}
              eventTitle={String(order.eventTitle)}
              eventSlug={eventSlug}
              startsAt={String(order.startsAt ?? new Date().toISOString())}
              endsAt={String(order.endsAt ?? new Date().toISOString())}
              venueName={order.venueName ? String(order.venueName) : null}
              venueAddress={order.venueAddress ? String(order.venueAddress) : null}
            />

            <div className="rounded-lg border border-border bg-muted p-5 text-left text-sm text-muted-foreground">
              <p className="font-semibold text-foreground">
                {isAwaitingDeposit ? "입금 후 안내" : "이벤트 당일 안내"}
              </p>
              <ul className="mt-3 space-y-2">
                {guideLines.map((line) => (
                  <li key={line}>• {line}</li>
                ))}
              </ul>
              <p className="mt-4 text-xs">
                문의가 필요하신가요?{" "}
                <a href="mailto:support@pickket.kr" className="text-primary hover:underline">
                  support@pickket.kr
                </a>
              </p>
            </div>

            <div className="flex justify-center">
              <ShareButtons title={String(order.eventTitle)} url={shareUrl} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
