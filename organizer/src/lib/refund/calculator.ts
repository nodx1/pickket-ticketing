export interface RefundRule {
  daysBefore: number;
  percent: number;
  label: string;
}

interface CalculateRefundResult {
  refundAmount: number;
  refundPercent: number;
  policyLabel: string;
  canRefund: boolean;
}

const defaultRules: RefundRule[] = [
  { daysBefore: 10, percent: 100, label: "D-10 이전" },
  { daysBefore: 7, percent: 90, label: "D-7 ~ D-10" },
  { daysBefore: 3, percent: 80, label: "D-3 ~ D-7" },
  { daysBefore: 1, percent: 70, label: "D-1 ~ D-3" },
  { daysBefore: 0, percent: 0, label: "당일" },
];

function diffInDays(eventStartAt: Date, now: Date) {
  const ms = eventStartAt.getTime() - now.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function calculateRefund(
  eventStartAt: Date,
  orderTotal: number,
  now = new Date(),
  customRules?: RefundRule[],
): CalculateRefundResult {
  const days = diffInDays(eventStartAt, now);
  const rules = (customRules && customRules.length > 0 ? customRules : defaultRules)
    .slice()
    .sort((left, right) => right.daysBefore - left.daysBefore);

  const matchedRule = rules.find((rule) => days >= rule.daysBefore) ?? rules[rules.length - 1];
  const refundPercent = matchedRule?.percent ?? 0;
  const refundAmount = Math.round((orderTotal * refundPercent) / 100);

  return {
    refundAmount,
    refundPercent,
    policyLabel: matchedRule?.label ?? "환불 규정 없음",
    canRefund: refundPercent > 0,
  };
}
