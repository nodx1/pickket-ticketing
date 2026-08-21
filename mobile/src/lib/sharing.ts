/**
 * 소셜 공유 유틸리티
 * 이벤트/티켓 공유
 */
import { Share, Platform } from "react-native";
import { trackShare } from "./analytics";

interface ShareEventParams {
  eventId: string;
  title: string;
  date?: string;
  venue?: string;
}

interface ShareTicketParams {
  eventId: string;
  title: string;
  date?: string;
}

/** 이벤트 공유 */
export async function shareEvent({ eventId, title, date, venue }: ShareEventParams): Promise<boolean> {
  const url = `https://pickket.kr/events/${eventId}`;
  const lines = [title];
  if (date) lines.push(date);
  if (venue) lines.push(venue);
  lines.push(url);

  try {
    const result = await Share.share(
      Platform.OS === "ios"
        ? { message: lines.join("\n"), url }
        : { message: lines.join("\n") },
      { dialogTitle: title },
    );

    if (result.action === Share.sharedAction) {
      trackShare(eventId, result.activityType ?? "unknown");
      return true;
    }
    return false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return false;
  }
}

/** "I'm going!" 티켓 공유 */
export async function shareTicket({ eventId, title, date }: ShareTicketParams): Promise<boolean> {
  const url = `https://pickket.kr/events/${eventId}`;
  const message = `🎫 I'm going! ${title}${date ? ` (${date})` : ""}\n${url}`;

  try {
    const result = await Share.share(
      Platform.OS === "ios"
        ? { message, url }
        : { message },
      { dialogTitle: "Share Ticket" },
    );

    if (result.action === Share.sharedAction) {
      trackShare(eventId, result.activityType ?? "unknown");
      return true;
    }
    return false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return false;
  }
}
