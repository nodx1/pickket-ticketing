/* ══════════════════════════════════════════════════════════════
   커뮤니티 허브 타입
   ══════════════════════════════════════════════════════════════ */

export type FeedRole = "fan" | "verified_attendee" | "organizer" | "artist";
export type FeedFilterTab = "all" | "official" | "fan" | "verified";

export interface SocialEmbed {
  platform: "instagram" | "x" | "tiktok" | "youtube";
  url: string;
  thumbnail: string;
  caption: string;
  author: string;
  authorHandle: string;
  likeCount: number;
  commentCount: number;
}

export interface UnifiedFeedItem {
  id: string;
  userId?: string;
  role: FeedRole;
  user: string;
  avatar: string;
  text: string;
  likes: number;
  replies: number;
  createdAt: string;
  pinned?: boolean;
  postType?: "announcement" | "update" | "event_promotion";
  readCount?: number;
  image?: string;
  reactions?: Record<string, number>;
  scarcityLabel?: string;
  isVerifiedAttendee?: boolean;
  socialEmbed?: SocialEmbed;
  fanLevel?: 1 | 2 | 3 | 4 | 5;
}
