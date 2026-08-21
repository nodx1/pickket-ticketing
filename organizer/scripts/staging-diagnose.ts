import dns from "node:dns/promises";
import tls from "node:tls";
import { loadLocalEnv, redact } from "./ops/env";

loadLocalEnv();

const baseUrl = new URL(process.env.STAGING_BASE_URL ?? "https://go-staging.pickket.kr");
const host = baseUrl.hostname;
const port = Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80));

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function dnsSnapshot() {
  return {
    A: await safe(() => dns.resolve4(host)),
    AAAA: await safe(() => dns.resolve6(host)),
    CNAME: await safe(() => dns.resolveCname(host)),
    ANY: await safe(() => dns.resolveAny(host)),
  };
}

async function tlsSnapshot() {
  if (baseUrl.protocol !== "https:") return { skipped: true, reason: "not_https" };
  return await new Promise<Record<string, unknown>>((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerCertificate();
      resolve({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ?? null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher().name,
        subject: certificate.subject ?? null,
        issuer: certificate.issuer ?? null,
        validFrom: certificate.valid_from ?? null,
        validTo: certificate.valid_to ?? null,
        subjectAltName: certificate.subjectaltname ?? null,
      });
      socket.destroy();
    });
    socket.setTimeout(8_000, () => {
      socket.destroy();
      resolve({ error: "TLS timeout" });
    });
    socket.on("error", (error) => resolve({ error: error.message }));
  });
}

async function httpSnapshot() {
  const started = Date.now();
  try {
    const response = await fetch(new URL("/api/health/live", baseUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "pickket-staging-diagnose/1.0", accept: "application/json" },
    });
    const body = (await response.text()).slice(0, 1_000);
    const cfError = body.match(/error code[:\s]+(\d+)/i)?.[1]
      ?? body.match(/(?:error_code|code)["']?\s*[:=]\s*["']?(\d+)/i)?.[1]
      ?? null;
    return {
      url: new URL("/api/health/live", baseUrl).toString(),
      status: response.status,
      latencyMs: Date.now() - started,
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
      cfCacheStatus: response.headers.get("cf-cache-status"),
      cfErrorCode: cfError,
      contentType: response.headers.get("content-type"),
      bodyPreview: body.replace(/(token|secret|password|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1:[redacted]"),
      diagnosis: response.status === 530 && cfError === "1016"
        ? "Cloudflare origin DNS failure (1016): verify the proxied record target and origin hostname."
        : response.status >= 500 ? "Origin or edge failure: inspect service status, port, TLS and health check." : "reachable",
    };
  } catch (error) {
    return { status: 0, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

async function cloudflareSnapshot() {
  const token = process.env.CF_API_TOKEN?.trim();
  const zoneId = process.env.CF_ZONE_ID?.trim();
  if (!token || !zoneId) return { skipped: true, reason: "CF_API_TOKEN/CF_ZONE_ID not provided" };
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(host)}`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: Array<Record<string, unknown>> } | null;
  return {
    status: response.status,
    success: payload?.success ?? false,
    records: (payload?.result ?? []).map((record) => ({
      type: record.type,
      name: record.name,
      content: typeof record.content === "string" ? redact(record.content, 4) : record.content,
      proxied: record.proxied,
      ttl: record.ttl,
    })),
  };
}

async function main() {
  const result = {
    checkedAt: new Date().toISOString(),
    target: { url: baseUrl.toString(), host, port },
    dns: await dnsSnapshot(),
    tls: await tlsSnapshot(),
    http: await httpSnapshot(),
    cloudflare: await cloudflareSnapshot(),
    nextChecks: [
      "Cloudflare DNS proxied record must point to the active staging origin/ALB, not an absent hostname.",
      "Origin must listen on the platform target port and expose /api/health/live.",
      "After repair run scripts/staging-smoke.ts and scripts/cron-smoke.ts.",
    ],
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
