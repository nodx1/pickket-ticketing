/**
 * Live Wrapped 타입 — 연말 회고
 * 피처플래그: LIVE_WRAPPED
 */

export interface WrappedStats {
  year: number;
  total_shows: number;
  total_hours: number;
  total_artists: number;
  top_artist: {
    name: string;
    image_url?: string;
    count: number;
  };
  top_genre: {
    name: string;
    count: number;
  };
  top_venue: {
    name: string;
    count: number;
  };
  monthly_breakdown: Array<{
    month: number;
    count: number;
  }>;
  highlights: Array<{
    event_title: string;
    date: string;
    image_url?: string;
  }>;
}
