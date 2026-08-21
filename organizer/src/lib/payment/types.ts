export interface PaymentPrepareParams {
  orderId: string;
  amount: number;
  orderName: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  successUrl: string;
  failUrl: string;
}

export interface PaymentResult {
  success: boolean;
  paymentKey: string;
  method: string;
  approvedAt: string;
  receipt?: string;
  /**
   * 가상계좌 '발급 완료, 입금 대기' 상태. success=false 이면서 실패도 아니다.
   * true 면 호출측은 주문을 completed 로 확정하지 말고 pending 유지해야 한다
   * (실입금 완료 웹훅에서 확정). (감사 P0-1)
   */
  pending?: boolean;
}

export interface CancelResult {
  success: boolean;
  cancelAmount: number;
  cancelledAt: string;
}

export interface PaymentProvider {
  prepare(params: PaymentPrepareParams): Promise<{ redirectUrl: string; paymentKey?: string }>;
  confirm(params: { paymentKey: string; orderId: string; amount: number }): Promise<PaymentResult>;
  cancel(params: { paymentKey: string; reason: string; amount?: number }): Promise<CancelResult>;
}
