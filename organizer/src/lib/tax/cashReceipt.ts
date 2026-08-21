interface IssueCashReceiptParams {
  orderId: string;
  identityNumber: string;
  amount: number;
  type: "income" | "expense";
}

export async function issueCashReceipt(params: IssueCashReceiptParams) {
  return {
    success: true,
    requestedAt: new Date().toISOString(),
    ...params,
  };
}
