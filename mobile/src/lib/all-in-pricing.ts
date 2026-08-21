/**
 * All-In Pricing — P1 정직한 가격
 * 서비스 수수료를 포함한 총 가격 계산
 */
export function calcAllInPrice(basePrice: number, serviceFeeRate = 0.11) {
  const fee = Math.round(basePrice * Math.min(serviceFeeRate, 0.20));
  return { total: basePrice + fee, serviceFee: fee, basePrice };
}
