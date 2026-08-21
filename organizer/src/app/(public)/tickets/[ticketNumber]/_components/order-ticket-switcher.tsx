import Link from "next/link";

/**
 * 🔴 같은 주문의 티켓 사이를 옮겨 다니는 줄 (2026-08-19, 대회 D-1).
 *
 * ## 왜 필요한가
 *
 * 구매완료 알림톡·메일의 딥링크는 **첫 장 하나**다. 티켓 화면에도 나머지로 가는 길이
 * 없어서, 2장 이상 산 구매자는 자기가 산 티켓 중 1장밖에 못 열었다.
 *
 *     prod 실측: 유료 복수구매 54명 · 120장 → **64장이 링크로 닿지 않았다**
 *
 * 구제 경로(`/my-tickets` 이메일+전화)는 있었지만 **버튼이 있는 메일은 그걸 안내조차
 * 하지 않았다**(안내 문구가 `hasTicketLink === false` 분기에만 있었다). 길은 있는데
 * 아무도 몰랐다.
 *
 * ## 왜 캐러셀이 아니라 링크인가
 *
 * 게이트에서 쓰는 화면이다. 캐러셀은 상태를 들고 있어야 하고, 스와이프가 안 먹거나
 * 한 장만 렌더된 채로 굳으면 **입구에서 줄이 선다**. 각 장이 자기 URL 을 갖는 링크는
 * 새로고침·뒤로가기·공유가 전부 그냥 된다. 스태프가 "3번 눌러주세요" 라고 말할 수도 있다.
 *
 * ⚠️ 이 컴포넌트는 **접근 판정을 하지 않는다.** 호출부(page.tsx)가 이미 판정한 뒤
 *    넘겨준 것만 그린다 — 여기서 다시 판정하면 두 곳이 갈린다.
 */
export function OrderTicketSwitcher({
  items,
}: {
  items: Array<{ ticketNumber: string; href: string; isCurrent: boolean; dayLabel: string | null }>;
}) {
  if (items.length < 2) return null;
  const currentIndex = items.findIndex((i) => i.isCurrent);

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <p className="text-sm font-medium text-foreground">
        이 주문의 티켓 {items.length}장
        {currentIndex >= 0 ? (
          <span className="ml-1 text-muted-foreground">· 지금 {currentIndex + 1}번째</span>
        ) : null}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        일행 몫은 아래에서 번호를 눌러 각각 보여주세요. 입장할 때마다 해당 번호의 QR이 필요합니다.
      </p>
      {/* 🔴 가로 스크롤 — 4장을 넘겨도 줄이 안 깨진다. 좁은 폰에서 버튼이 뭉개지면
          현장에서 못 누른다. */}
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {items.map((item, index) => (
          <Link
            key={item.ticketNumber}
            href={item.href}
            aria-current={item.isCurrent ? "page" : undefined}
            className={[
              "flex min-w-[3.25rem] shrink-0 flex-col items-center rounded-lg border px-3 py-2 text-sm",
              item.isCurrent
                ? "border-primary bg-primary text-white"
                : "border-border bg-card text-foreground hover:border-primary",
            ].join(" ")}
          >
            <span className="font-bold">{index + 1}</span>
            {item.dayLabel ? (
              <span className={item.isCurrent ? "text-[10px] text-white/80" : "text-[10px] text-muted-foreground"}>
                {item.dayLabel}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
}
