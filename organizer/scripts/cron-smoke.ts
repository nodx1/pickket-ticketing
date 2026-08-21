import { loadLocalEnv, parsePositiveInt } from "./ops/env";

loadLocalEnv();
const base = new URL(process.env.CRON_SMOKE_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3013");
const secret = process.env.CRON_SMOKE_SECRET ?? process.env.CRON_SECRET;
const allowMutation = process.env.CRON_SMOKE_ALLOW_MUTATION === "1";
const concurrency = parsePositiveInt("CRON_SMOKE_CONCURRENCY", 10, 20);
const routes = [
  "retry-order-webhooks",
  "dispatch-messages",
  "dispatch-campaigns",
  "reconcile-deliveries",
  "ops-cleanup",
] as const;

type Probe = { route: string; mode: string; status: number; ok: boolean; rateLimited?: boolean; detail?: string };
const probes: Probe[] = [];
let callSequence = 0;

async function call(route: string, mode: "none" | "wrong" | "valid"): Promise<Probe> {
  callSequence += 1;
  // Keep the synthetic smoke traffic below the app-wide anonymous 60/minute
  // limiter while still exercising endpoint-level concurrency.
  const syntheticIp = `198.51.100.${((callSequence - 1) % 250) + 1}`;
  const headers: Record<string, string> = { accept: "application/json", "x-cron-timestamp": new Date().toISOString(), "x-forwarded-for": syntheticIp };
  if (mode === "wrong") headers.authorization = "Bearer invalid-cron-secret";
  if (mode === "valid") headers.authorization = `Bearer ${secret}`;
  try {
    const response = await fetch(new URL(`/api/cron/${route}`, base), { headers, signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    const rateLimited = response.status === 429;
    return { route, mode, status: response.status, rateLimited, ok: mode === "valid"
      ? (response.status >= 200 && response.status < 300) || rateLimited
      : response.status === 401, detail: body.slice(0, 300) };
  } catch (error) {
    return { route, mode, status: 0, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  for (const route of routes) {
    probes.push(await call(route, "none"));
    probes.push(await call(route, "wrong"));
  }

  if (allowMutation) {
    if (!secret) throw new Error("CRON_SMOKE_ALLOW_MUTATION=1 requires CRON_SMOKE_SECRET or CRON_SECRET");
    for (const route of routes) {
      const results = await Promise.all(Array.from({ length: concurrency }, () => call(route, "valid")));
      probes.push(...results);
    }
    for (const route of routes) {
      const routeResults = probes.filter((probe) => probe.route === route && probe.mode === "valid");
      if (!routeResults.some((probe) => probe.status >= 200 && probe.status < 300)) {
        probes.push({ route, mode: "valid-summary", status: 0, ok: false, detail: "concurrency control rejected every authenticated call; at least one successful execution is required" });
      }
    }
  } else {
    console.error("authenticated cron calls skipped; set CRON_SMOKE_ALLOW_MUTATION=1 to run provider/DB work");
  }

  const failed = probes.filter((probe) => !probe.ok);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), baseUrl: base.toString(), concurrency: allowMutation ? concurrency : 0, probes, passed: probes.length - failed.length, failed: failed.length }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
