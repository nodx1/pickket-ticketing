/**
 * 포토카드 타입
 * 피처플래그: PHOTO_CARDS
 */

export type PhotoCardRarity = "common" | "rare" | "epic" | "legendary";

export interface PhotoCard {
  id: string;
  artist_name: string;
  event_title: string;
  image_url: string;
  rarity: PhotoCardRarity;
  obtained_at: string;
  serial_number: string; // e.g. "#0042/1000"
  is_tradeable: boolean;
}

export interface PhotoCardCollection {
  total: number;
  by_rarity: Record<PhotoCardRarity, number>;
  cards: PhotoCard[];
}
