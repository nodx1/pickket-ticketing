/**
 * OCR 티켓 임포트 타입
 * 피처플래그: OCR_IMPORT
 */

export interface OcrScanResult {
  raw_text: string;
  confidence: number;
  extracted_fields: {
    event_title?: string;
    venue?: string;
    date?: string;
    seat?: string;
    ticket_number?: string;
    price?: number;
  };
  matched_event_id?: string; // Pickket 이벤트 매칭 시
}

export interface ImportedTicket {
  id: string;
  scan_result: OcrScanResult;
  status: "pending" | "verified" | "rejected";
  created_at: string;
  verified_at?: string;
}
