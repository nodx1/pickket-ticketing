import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = path.resolve(process.cwd(), "infra/cron");
const files = fs.readdirSync(source).filter((file) => file.endsWith(".yaml") && !["kustomization.yaml", "service-account.yaml"].includes(file));
const validator = path.resolve(process.cwd(), "scripts/validate-scheduler.ts");

function run(mutator: (name: string, content: string) => string | null): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickket-scheduler-negative-"));
  try {
    for (const file of files) {
      const content = fs.readFileSync(path.join(source, file), "utf8");
      const mutated = mutator(file, content);
      if (mutated !== null) fs.writeFileSync(path.join(root, file), mutated);
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", validator], {
      env: { ...process.env, SCHEDULER_MANIFEST_ROOT: root },
      encoding: "utf8",
    });
    return result.status !== 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cases: Array<[string, (name: string, content: string) => string | null]> = [
  ["missing cron", (name) => name === "ops-cleanup.yaml" ? null : fs.readFileSync(path.join(source, name), "utf8")],
  ["missing secret", (_name, content) => content.replace("name: pickket-go-stg-secrets", "name: missing-secret")],
  ["Allow concurrency", (_name, content) => content.replace("concurrencyPolicy: Forbid", "concurrencyPolicy: Allow")],
  ["missing timeout", (_name, content) => content.replace(/--max-time\s+\d+\s+/g, "")],
  ["wrong endpoint", (name, content) => content.replace(`$GO_BASE_URL/api/cron/${name.replace(/\.yaml$/, "")}`, "$GO_BASE_URL/api/cron/wrong")],
];

const results = cases.map(([name, mutate]) => ({ name, detected: run(mutate) }));
console.log(JSON.stringify({ results, ready: results.every((result) => result.detected) }, null, 2));
if (results.some((result) => !result.detected)) process.exitCode = 1;
