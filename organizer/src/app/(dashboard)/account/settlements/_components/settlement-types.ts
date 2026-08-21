export interface SettlementRow {
  id: string;
  eventId: string | null;
  eventTitle: string | null;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  platformFee: number;
  platformFeeRate: number | null;
  pgFee: number;
  refundAmount: number;
  netAmount: number;
  orderCount: number;
  status: "pending" | "processing" | "completed";
  paidAt: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  memo: string | null;
  v2ComputedAt: string | null;
}

export interface EventOption {
  id: string;
  title: string;
  status: string;
  endsAt: string | null;
}

export interface BankForm {
  bankName: string;
  bankAccount: string;
  bankHolder: string;
}
