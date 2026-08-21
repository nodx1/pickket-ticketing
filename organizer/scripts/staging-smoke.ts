import { loadLocalEnv } from "./ops/env";

loadLocalEnv();
const base = new URL(process.env.STAGING_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3013");
const cronSecret = process.env.STAGING_CRON_SECRET ?? process.env.CRON_SECRET;

type Check = { name: string; url: string; expected: number[]; actual?: number; ok: boolean; detail?: string };
const checks: Check[] = [];

async function check(name: string, path: string, expected: number[], init?: RequestInit): Promise<string | null> {
  const url = new URL(path, base).toString();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
    const body = await response.text();
    checks.push({ name, url, expected, actual: response.status, ok: expected.includes(response.status), detail: body.slice(0, 240) });
    return body;
  } catch (error) {
    checks.push({ name, url, expected, actual: 0, ok: false, detail: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function main() {
  const home = await check("public home", "/", [200]);
  await check("liveness", "/api/health/live", [200]);
  await check("readiness", "/api/health/ready", [200]);
  await check("login page", "/login", [200]);
  await check("cron unauthenticated", "/api/cron/retry-order-webhooks", [401]);
  await check("admin unauthenticated", "/api/admin/ops/recovery-summary", [401]);

  if (home) {
  const html = home;
  const asset = html.match(/\/_next\/static\/[^"']+\.js/)?.[0];
  if (asset) await check("first static asset", asset, [200]);
  else checks.push({ name: "first static asset", url: new URL("/", base).toString(), expected: [200], actual: 0, ok: false, detail: "no Next static asset found" });
}

  if (cronSecret) {
    await check("cron authenticated", "/api/cron/retry-order-webhooks", [200, 204], {
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
  } else {
    checks.push({ name: "cron authenticated", url: new URL("/api/cron/retry-order-webhooks", base).toString(), expected: [200, 204], actual: 0, ok: false, detail: "STAGING_CRON_SECRET/CRON_SECRET not provided" });
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), baseUrl: base.toString(), checks, passed: checks.length - failed.length, failed: failed.length }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
