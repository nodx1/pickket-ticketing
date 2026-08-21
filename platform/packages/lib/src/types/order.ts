/**
 * Order-related type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface OrderDetail {
  id: string;
  user_id: string;
  event_id: string;
  tier_id: string | null;
  order_type: string;
  status: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  payment_currency: string;
  payment_id: string | null;
  pg_provider: string | null;
  pg_transaction_id: string | null;
  payment_deadline: string | null;
  payment_started_at: string | null;
  pg_approved_at: string | null;
  authorized_at: string | null;
  captured_at: string | null;
  payment_failed_at: string | null;
  payment_failed_reason: string | null;
  created_at: string;
}

export interface NicePayProviderParams {
  js_url: string;
  form: Record<string, string>;
}

export interface PaymentPrepareResponse {
  order_id: string;
  provider: string;
  payment_id: string;
  amount: number;
  currency: string;
  redirect_url: string;
  payment_deadline: string;
  status: string;
  /** 나이스페이 구형 결제창 파라미터(provider="nicepay" 일 때만). 토스면 null/미포함. */
  provider_params?: NicePayProviderParams | null;
}
