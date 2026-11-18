/**
 * 게시 점검 「티켓 (좌석 등급)」 항목 판정.
 *
 * 지정석(assigned) 행사는 등급 + 발행된 배치도가 있어야 판매할 수 있다.
 * 자유 입장(unassigned) 행사는 배치도가 없고 등급 수량만으로 판매하므로 등급이 있으면 통과다.
 * (예전에는 자유 입장 행사에도 「배치도가 아직 발행되지 않았습니다」 경고가 떠서 주최사가
 *  필요 없는 배치도를 그리러 가게 만들었다.)
 */
export type TicketCheckInput = {
  tierCount: number;
  publishedMapCount: number;
  seatCount: number;
  seatType?: "assigned" | "unassigned" | null;
};

export function ticketCheckItem({ tierCount, publishedMapCount, seatCount, seatType }: TicketCheckInput): {
  status: "pass" | "warn" | "fail";
  message: string;
} {
  if (tierCount === 0) {
    return {
      status: "fail",
      message:
        seatType === "unassigned"
          ? "입장권 등급을 1개 이상 추가해주세요."
          : "좌석 등급을 1개 이상 추가하고 배치도를 발행해주세요.",
    };
  }
  if (seatType === "unassigned") {
    return { status: "pass", message: `${tierCount}개 등급 등록 · 자유 입장(배치도 없이 등급 수량으로 판매)` };
  }
  if (publishedMapCount > 0) {
    return { status: "pass", message: `${tierCount}개 등급 · ${seatCount}석 등록 · 배치도 발행됨` };
  }
  return { status: "warn", message: `${tierCount}개 등급 등록됐지만 배치도가 아직 발행되지 않았습니다.` };
}
