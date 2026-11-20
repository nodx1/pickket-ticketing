/**
 * 지도 API 연동(과업지시서 2-1) — 오픈스트리트맵 화면 도우미.
 *
 * 지도 그림은 오픈스트리트맵이 제공하는 임베드 페이지(iframe)로 띄운다. 별도 지도 라이브러리·키가 없다.
 * 장소 검색은 브라우저가 지도 제공자를 직접 부르지 않고 우리 서버(/api/maps/search → v2)를 거친다
 * (이용 정책: 호출 간격·캐시·User-Agent 를 서버 한 곳에서 지킨다).
 */

export interface MapPlace {
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: string | null;
  source_id: string;
}

export interface MapSearchResult {
  provider: string;
  attribution: string;
  places: MapPlace[];
}

/** 좌표 주변을 보여 주는 오픈스트리트맵 임베드 주소(가운데 핀 표시). */
export function osmEmbedUrl(lat: number, lng: number, zoomSpan = 0.004): string {
  const dLat = zoomSpan * 0.6;
  const bbox = [lng - zoomSpan, lat - dLat, lng + zoomSpan, lat + dLat].map((v) => v.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** 큰 지도로 열기(오픈스트리트맵 사이트). */
export function osmPageUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=17/${lat.toFixed(6)}/${lng.toFixed(6)}`;
}

/** 좌표가 둘 다 있고 범위 안일 때만 true. */
export function hasCoords(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
