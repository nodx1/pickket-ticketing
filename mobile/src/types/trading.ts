/**
 * 포토카드 트레이딩 타입
 * 피처플래그: PHOTO_CARD_TRADING
 */

export type TradeStatus = "open" | "pending" | "completed" | "cancelled" | "expired";

export interface TradeOffer {
  id: string;
  seller_id: string;
  seller_name: string;
  card_id: string;
  card_artist: string;
  card_event: string;
  card_rarity: string;
  card_image_url: string;
  asking_price?: number; // KRW, null = 교환 전용
  trade_for?: string; // 교환 희망 카드 설명
  status: TradeStatus;
  created_at: string;
  expires_at: string;
}

export interface TradeRequest {
  id: string;
  offer_id: string;
  buyer_id: string;
  buyer_name: string;
  offered_card_id?: string; // 교환 제안 카드
  offered_price?: number;
  message?: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}
