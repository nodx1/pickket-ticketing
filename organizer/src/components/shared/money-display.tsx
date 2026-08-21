import { formatKRW } from "@/lib/format";

interface MoneyDisplayProps {
  amount: number;
  className?: string;
}

export function MoneyDisplay({ amount, className }: MoneyDisplayProps) {
  return <span className={className}>{formatKRW(amount)}</span>;
}
