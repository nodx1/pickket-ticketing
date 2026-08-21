// 당첨 경품번호(raffle_number) 목록 표시 — 배지 그리드. 수신자 신원은 v2 미제공(후속).
export function WinningNumbers({ numbers }: { numbers: number[] }) {
  if (numbers.length === 0) {
    return <p className="text-sm text-content-subtle">당첨 번호가 없습니다.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {numbers.map((n) => (
        <span
          key={n}
          className="inline-flex min-w-[3rem] items-center justify-center rounded-lg border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm font-bold tabular-nums text-primary"
        >
          {n}
        </span>
      ))}
    </div>
  );
}
