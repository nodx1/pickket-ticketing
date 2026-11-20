import { describe, expect, it } from "vitest";
import { hasCoords, osmEmbedUrl, osmPageUrl } from "./osm";

describe("지도 도우미(오픈스트리트맵)", () => {
  it("임베드 주소에 좌표 핀과 주변 범위를 싣는다", () => {
    const url = new URL(osmEmbedUrl(37.5409, 127.0026));
    expect(url.origin).toBe("https://www.openstreetmap.org");
    expect(url.searchParams.get("marker")).toBe("37.540900,127.002600");
    const [minLng, minLat, maxLng, maxLat] = url.searchParams.get("bbox")!.split(",").map(Number);
    expect(minLng).toBeLessThan(127.0026);
    expect(maxLng).toBeGreaterThan(127.0026);
    expect(minLat).toBeLessThan(37.5409);
    expect(maxLat).toBeGreaterThan(37.5409);
  });

  it("크게 보기 주소는 같은 좌표를 연다", () => {
    expect(osmPageUrl(37.668, 126.745)).toContain("mlat=37.668000&mlon=126.745000");
  });

  it("좌표는 둘 다 있고 범위 안일 때만 유효", () => {
    expect(hasCoords(37.5, 127)).toBe(true);
    expect(hasCoords(37.5, null)).toBe(false);
    expect(hasCoords(null, null)).toBe(false);
    expect(hasCoords(95, 127)).toBe(false);
    expect(hasCoords(Number.NaN, 127)).toBe(false);
  });
});
