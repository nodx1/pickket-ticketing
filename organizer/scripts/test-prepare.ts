import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }

    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;

    process.env[key] = unquoted;
  }
}

function run(command: string, cwd: string) {
  execSync(command, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
}

export function prepareTestDatabase() {
  const root = process.cwd();
  loadEnvFile(path.join(root, ".env.local"));

  run("npx tsx scripts/migrate.ts", root);
  run("npx tsx scripts/seed.ts", root);
  // BFF cutover: 로그인 검증은 v2 가 SoT → 테스트 계정을 v2 에 프로비저닝(정책준수 비번).
  // 미실행 시 demo@ 가 v2 에 없어 모든 인증 E2E 가 401→계정잠금으로 연쇄실패한다.
  run("npx tsx scripts/provision-v2-test-accounts.ts", root);
  // 시드 go 이벤트를 v2 에 write-through 연계(v2_event_id). 미실행 시 createOrder/상품
  // write-through 가 v2_event_id 부재로 실패 → order→ticket→checkin 통합 e2e 가 깨진다.
  run("npx tsx scripts/provision-v2-events.ts", root);
}

if (require.main === module) {
  prepareTestDatabase();
}
