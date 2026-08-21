import { EVENT_TYPE_LABELS } from "@/lib/constants";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";
import { formatDateKst } from "@/lib/format";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  // ── 레벨2 컷오버 W2-PUB ──
  // go `events + organizers/event_organizers` JOIN → v2 이벤트 상세 read.
  // 상태 게이트 없음(기존 동작 유지) — OG 카드는 draft 미리보기에서도 렌더돼야 한다.
  // ⚠️ v2 불가는 404 가 아니라 503 — 크롤러가 404 를 캐시하면 SNS 카드가 영구히 깨진다.
  const resolved = await resolvePublicEventById(eventId, PUBLIC_ANY_STATUS);
  if (!resolved.ok) {
    return new Response(resolved.error, { status: resolved.status });
  }
  const event = resolved.event;

  // SVG 속성에 직접 보간되므로 HEX 형식만 허용 (XML/스크립트 인젝션 차단)
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  const rawAccent = event.homepage_design?.accentColor;
  const accentColor =
    typeof rawAccent === "string" && HEX_COLOR.test(rawAccent) ? rawAccent : "#5FD3BC";
  const eventTypeRaw = event.event_type ?? "";
  const eventTypeLabel =
    EVENT_TYPE_LABELS[eventTypeRaw as keyof typeof EVENT_TYPE_LABELS] ?? eventTypeRaw;
  // 🔴 OG 이미지는 **서버에서** 그려 카톡·검색 미리보기에 박힌다 —
  //    서버 시간대에 밀리면 공유된 카드에 하루 틀린 날짜가 남는다.
  const dateLabel = formatDateKst(event.event_date, "일정 미정");

  const title = escapeXml(event.title);
  const venue = escapeXml(event.venue ?? "장소 미정");
  // go `organizers.name` → v2 organizer_name(OrganizerProfile.company_name). 미등록 시 폴백.
  const organizer = escapeXml(event.organizer_name ?? "PICKKET");
  const typeLabel = escapeXml(eventTypeLabel);
  const dateText = escapeXml(dateLabel);

  const svg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
          <stop stop-color="#F5F3FF"/>
          <stop offset="0.45" stop-color="#FAFBFF"/>
          <stop offset="1" stop-color="#EEF2FF"/>
        </linearGradient>
        <linearGradient id="card" x1="88" y1="88" x2="1112" y2="542" gradientUnits="userSpaceOnUse">
          <stop stop-color="rgba(255,255,255,0.95)"/>
          <stop offset="1" stop-color="${accentColor}18"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#bg)"/>
      <rect x="72" y="72" width="1056" height="486" rx="36" fill="url(#card)" stroke="rgba(0,0,0,0.08)"/>
      <text x="120" y="144" fill="${accentColor}" font-size="24" font-family="Arial, sans-serif" font-weight="800" letter-spacing="4">PICKKET.GO EVENT</text>
      <rect x="936" y="110" width="152" height="46" rx="23" fill="rgba(108,92,231,0.08)"/>
      <text x="1012" y="140" fill="#3A3F5C" text-anchor="middle" font-size="20" font-family="Arial, sans-serif" font-weight="700">${typeLabel}</text>
      <text x="120" y="276" fill="#1A1D2E" font-size="64" font-family="Arial, sans-serif" font-weight="900">${title}</text>
      <text x="120" y="344" fill="#5D6382" font-size="28" font-family="Arial, sans-serif">${dateText} · ${venue}</text>
      <text x="120" y="502" fill="#3A3F5C" font-size="24" font-family="Arial, sans-serif">주최 ${organizer}</text>
      <text x="1080" y="502" fill="rgba(0,0,0,0.35)" text-anchor="end" font-size="18" font-family="Arial, sans-serif">스마트 이벤트 운영 플랫폼</text>
    </svg>
  `.trim();

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      // SVG 를 직접 열람할 때 인라인 스크립트 실행을 막는 2차 방어
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
