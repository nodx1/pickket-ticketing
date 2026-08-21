// #2 추첨 화면 공용 타입 — go 라우트(toGoDraw) 응답 형태(camelCase).
export interface RaffleDraw {
  drawId: string;
  drawKey: string | null;
  seed: string;
  winnerCount: number;
  poolSize: number;
  // 당첨 경품번호(raffle_number)만 제공. 수신자 신원 매핑은 v2 미제공(후속 카드).
  winningNumbers: number[];
  executedBy: string | null;
  executedAt: string;
}
