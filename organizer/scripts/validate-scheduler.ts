import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.SCHEDULER_MANIFEST_ROOT ?? path.join(process.cwd(), "infra/cron"));
const required = new Map([
  ["retry-order-webhooks", "* * * * *"],
  ["dispatch-messages", "* * * * *"],
  ["dispatch-campaigns", "* * * * *"],
  ["dispatch-invitations", "* * * * *"],
  ["drain-audit-outbox", "* * * * *"],
  ["drain-waitlist-recovery", "* * * * *"],
  ["reconcile-deliveries", "*/5 * * * *"],
  ["payment-reconcile", "*/5 * * * *"],
  ["expire-orders", "*/5 * * * *"],
  ["reminders", "0 0 * * *"],
  ["seat-hold-reaper", "*/5 * * * *"],
  ["ops-cleanup", "15 0 * * *"],
]);
// 207(degraded)을 반환할 수 있는 HTTP 크론 — 호출측이 상태코드를 직접 판정해야 한다.
// `curl -f` 는 207 이 2xx 라 성공으로 통과시켜 미수렴 상태를 조용히 묻는다.
// expire-orders 추가(W3-OPS): go 앵커 sweep 실패 시 207 — 만료 참석자가 confirmed 로 잔류한다.
const degradedAwareHttpCrons = new Set([
  "drain-audit-outbox",
  "drain-waitlist-recovery",
  "expire-orders",
]);

const files = fs.readdirSync(root).filter((file) => file.endsWith(".yaml") && !["kustomization.yaml", "service-account.yaml"].includes(file));
const seen = new Map<string, string>();
const errors: string[] = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  const name = content.match(/^\s*name:\s*pickket-go-([a-z0-9-]+)\s*$/m)?.[1];
  if (!name) {
    errors.push(`${file}: metadata.name missing or not prefixed pickket-go-`);
    continue;
  }
  if (seen.has(name)) errors.push(`${name}: duplicate scheduler definition (${seen.get(name)}, ${file})`);
  seen.set(name, file);
  const schedule = content.match(/^\s*schedule:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
  if (required.get(name) !== schedule) errors.push(`${name}: schedule ${schedule ?? "missing"} != ${required.get(name) ?? "unexpected"}`);
  if (!/concurrencyPolicy:\s*Forbid/.test(content)) errors.push(`${name}: concurrencyPolicy must be Forbid`);
  if (!/timeZone:\s*"Etc\/UTC"/.test(content)) errors.push(`${name}: timeZone must be explicit Etc/UTC`);
  if (!/activeDeadlineSeconds:\s*\d+/.test(content)) errors.push(`${name}: activeDeadlineSeconds missing`);
  if (!/serviceAccountName:\s*pickket-go-cron/.test(content)) errors.push(`${name}: serviceAccountName pickket-go-cron missing`);
  const httpCron = content.includes("image: curlimages/curl");
  if (httpCron && !/--max-time\s+\d+/.test(content)) errors.push(`${name}: curl max-time missing`);
  if (httpCron && !content.includes(`$GO_BASE_URL/api/cron/${name}`)) errors.push(`${name}: cron endpoint mismatch`);
  if (degradedAwareHttpCrons.has(name)) {
    const commandBlock = content.split(/^\s+env:\s*$/m, 1)[0] ?? content;
    if (!/-w\s+'%\{http_code\}'/.test(commandBlock) || !/http_code/.test(commandBlock)) {
      errors.push(`${name}: explicit HTTP status parsing missing`);
    }
    if (!/\[\s*"\$http_code"\s*!=\s*"200"\s*\]/.test(commandBlock) || !/exit 1/.test(commandBlock)) {
      errors.push(`${name}: non-200 response must fail the CronJob`);
    }
    if (/curl[^\n]*\s-f[a-zA-Z]*/.test(commandBlock)) {
      errors.push(`${name}: curl -f cannot classify HTTP 207 degraded responses`);
    }
  }
  if (!/secretRef:\s*\n\s+name:\s*pickket-go-stg-secrets/.test(content)) errors.push(`${name}: secretRef pickket-go-stg-secrets missing`);
  if (/CRON_SECRET\s*:\s*["'][^$]/.test(content)) errors.push(`${name}: literal cron secret detected`);
}
for (const [name] of required) if (!seen.has(name)) errors.push(`${name}: required scheduler missing`);

const result = { checkedAt: new Date().toISOString(), authoritative: "kubernetes-cronjob", files, required: [...required], errors, ready: errors.length === 0 };
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exitCode = 1;
