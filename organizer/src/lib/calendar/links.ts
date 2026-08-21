/**
 * 캘린더 자동 추가 링크 생성 유틸리티
 * Google Calendar / Apple Calendar (.ics) / Naver Calendar
 */

interface CalendarEventParams {
  title: string;
  startsAt: string; // ISO 8601
  endsAt: string; // ISO 8601
  venueName?: string | null;
  venueAddress?: string | null;
  description?: string | null;
  url?: string | null;
}

function toGoogleDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Google Calendar — 웹 링크 (새 탭)
 */
export function googleCalendarUrl(params: CalendarEventParams): string {
  const { title, startsAt, endsAt, venueName, venueAddress, description, url } = params;
  const location = [venueName, venueAddress].filter(Boolean).join(", ");
  const details = [description, url ? `상세: ${url}` : ""].filter(Boolean).join("\n\n");

  const qs = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGoogleDate(startsAt)}/${toGoogleDate(endsAt)}`,
    ...(location ? { location } : {}),
    ...(details ? { details } : {}),
  });

  return `https://calendar.google.com/calendar/render?${qs.toString()}`;
}

/**
 * Naver Calendar — 웹 링크 (새 탭)
 */
export function naverCalendarUrl(params: CalendarEventParams): string {
  const { title, startsAt, endsAt, venueName, venueAddress } = params;
  const location = [venueName, venueAddress].filter(Boolean).join(", ");

  // 네이버 캘린더 딥링크
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const formatNaver = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;

  const qs = new URLSearchParams({
    calendarId: "",
    title,
    when: `${formatNaver(start)}/${formatNaver(end)}`,
    ...(location ? { where: location } : {}),
  });

  return `https://calendar.naver.com/calendar/friend/register?${qs.toString()}`;
}

/**
 * Apple Calendar / 범용 — .ics 파일 콘텐츠
 */
export function generateIcs(params: CalendarEventParams): string {
  const { title, startsAt, endsAt, venueName, venueAddress, description, url } = params;
  const location = [venueName, venueAddress].filter(Boolean).join(", ");
  const desc = [description, url ? `상세: ${url}` : ""].filter(Boolean).join("\\n");

  const formatIcs = (iso: string) =>
    new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@pickket.kr`;

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PICKKET//Event//KO",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `DTSTART:${formatIcs(startsAt)}`,
    `DTEND:${formatIcs(endsAt)}`,
    `SUMMARY:${title}`,
    ...(location ? [`LOCATION:${location}`] : []),
    ...(desc ? [`DESCRIPTION:${desc}`] : []),
    ...(url ? [`URL:${url}`] : []),
    `UID:${uid}`,
    `DTSTAMP:${formatIcs(new Date().toISOString())}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * .ics 다운로드용 data URI
 */
export function icsDataUri(params: CalendarEventParams): string {
  const ics = generateIcs(params);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}
