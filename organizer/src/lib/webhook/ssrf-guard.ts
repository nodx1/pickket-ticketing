/**
 * SSRF 가드 — 주최자가 등록한 웹훅 endpoint_url 이 내부망/메타데이터 주소로
 * 향하지 못하도록 차단한다.
 *
 * 공격 시나리오: endpoint_url 을 http://169.254.169.254/... (클라우드 메타데이터)
 * 또는 http://localhost:5434 (내부 DB) 로 등록 → 디스패처가 내부 자원에 POST 하고
 * 응답을 webhook_logs 에 저장해 주최자가 조회 → full-read SSRF + 자격증명 탈취.
 *
 * 방어: https 만 허용 + DNS 해석 결과가 사설/링크로컬/루프백/유니크로컬 IP 면 거부.
 * 호출 시점(전송 직전)과 등록 시점 모두에서 검증해 DNS rebinding 도 완화.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // 파싱 실패 = 거부
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 루프백
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 링크로컬 (클라우드 메타데이터 169.254.169.254)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a >= 224) return true; // 멀티캐스트/예약
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // 루프백/미지정
  if (v.startsWith("fe80")) return true; // 링크로컬
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // 유니크 로컬 (fc00::/7)
  if (v.startsWith("::ffff:")) {
    // IPv4-mapped → 내부 IPv4 우회 차단
    const mapped = v.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return ipv4IsPrivate(mapped);
  }
  return false;
}

/**
 * 외부로 안전하게 호출 가능한 URL 인지 검증. 위반 시 throw.
 */
export async function assertPublicWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("웹훅 URL 형식이 올바르지 않습니다");
  }

  if (url.protocol !== "https:") {
    throw new Error("웹훅 URL 은 https 만 허용됩니다");
  }

  const host = url.hostname;
  // 호스트가 이미 IP 리터럴이면 그대로 검사
  if (net.isIPv4(host)) {
    if (ipv4IsPrivate(host)) throw new Error("내부 주소로의 웹훅은 허용되지 않습니다");
    return;
  }
  if (net.isIPv6(host)) {
    if (ipv6IsPrivate(host)) throw new Error("내부 주소로의 웹훅은 허용되지 않습니다");
    return;
  }

  // 도메인이면 DNS 해석 후 모든 A/AAAA 레코드 검사 (multi-record rebinding 방어)
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(host, { all: true });
  } catch {
    throw new Error("웹훅 호스트를 확인할 수 없습니다");
  }
  if (records.length === 0) {
    throw new Error("웹훅 호스트를 확인할 수 없습니다");
  }
  for (const { address, family } of records) {
    const isPrivate = family === 6 ? ipv6IsPrivate(address) : ipv4IsPrivate(address);
    if (isPrivate) {
      throw new Error("내부 주소로의 웹훅은 허용되지 않습니다");
    }
  }
}
