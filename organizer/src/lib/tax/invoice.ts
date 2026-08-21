interface IssueTaxInvoiceParams {
  orderId: string;
  businessNumber: string;
  companyName: string;
  representative?: string;
  amount: number;
  taxAmount: number;
}

export async function issueTaxInvoice(params: IssueTaxInvoiceParams) {
  return {
    success: true,
    provider: "popbill",
    requestedAt: new Date().toISOString(),
    ...params,
  };
}
