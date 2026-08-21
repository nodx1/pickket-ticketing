import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

function loadEnvFile(fileName: string) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) {
    return {} as Record<string, string>;
  }

  const values: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3011");
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
const localFileEnv = loadEnvFile(".env.local");

const defaultTestEnv = {
  TOSS_WEBHOOK_SECRET: "test_toss_webhook_secret",
  KAKAO_WEBHOOK_SECRET: "test_kakao_webhook_secret",
  NAVER_WEBHOOK_SECRET: "test_naver_webhook_secret",
  PORTONE_WEBHOOK_SECRET: "test_portone_webhook_secret",
  PORTONE_WEBHOOK_ENABLED: "true",
  PLAYWRIGHT_TEST_RATE_LIMIT: "disabled",
} as const;

// ⚠️ V2_EVENT_SYNC_SECRET 은 go↔v2 HMAC 서명 공유 시크릿 — 절대 임의값으로 덮지 말 것
// (덮으면 organizer sync·로그인 등 go↔v2 전부 "Invalid X-Pickket-Signature" 로 깨짐).
// .env.local 의 실값을 러너 프로세스에도 노출해 내부 API 테스트가 같은 값을 헤더로 쓰게 한다.
if (!process.env.V2_EVENT_SYNC_SECRET && localFileEnv.V2_EVENT_SYNC_SECRET) {
  process.env.V2_EVENT_SYNC_SECRET = localFileEnv.V2_EVENT_SYNC_SECRET;
}

for (const [key, value] of Object.entries(defaultTestEnv)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

/**
 * 🔴 E2E 는 **e2e 전용 DB** 를 쓴다 (2026-08-02).
 *
 * 종전엔 `.env.local` 의 `PG_DATABASE=pickket_go` 를 그대로 써서, globalSetup 의
 * `migrate.ts` 가 **마이그레이션 240(W2-EVT DROP) 가드에 막혀** E2E 전체가 안 돌았다:
 *
 *     W2-EVT DROP 차단: 아직 데이터가 남아 있습니다 (organizers=1, event_organizers=28)
 *
 * 로컬에 go DB 가 **둘** 있고 상태가 다르다(읽기로 실측):
 *
 *     pickket_go       마이그 181 · organizers 테이블 **있음**  ← 가드에 걸린다
 *     pickket_go_e2e   마이그 189 · organizers 테이블 **없음**  ← 240 이 끝난 상태
 *
 * ⟹ 후자를 가리키면 **아무것도 쓰지 않고** 막힘이 풀린다. 개발용 DB(`pickket_go`)를
 *    건드리지 않는 것이 중요하다 — 그건 공유 자원이고, 되돌리기 어려운 DROP 이 걸려 있다.
 *
 * `E2E_PG_DATABASE` 로 덮어쓸 수 있다(다른 DB 로 돌려보고 싶을 때).
 */
const e2eDatabase = process.env.E2E_PG_DATABASE ?? "pickket_go_e2e";

const localServerEnv = {
  ...localFileEnv,
  ...process.env,
  PG_DATABASE: e2eDatabase,
  PLAYWRIGHT_TEST: "1",
  PORT: String(port),
  HOSTNAME: "127.0.0.1",
};

// globalSetup(migrate·seed)도 같은 DB 를 보게 한다 — 앱과 다른 DB 를 마이그레이션하면
// "성공했는데 화면은 옛 스키마" 가 된다(2026-07-31 에 alembic 으로 같은 사고).
process.env.PG_DATABASE = e2eDatabase;

// 외부 URL(스테이징/프로덕션) 대상 테스트 시 로컬 서버 기동 + DB 직접 접근 스킵
const isRemoteTarget = !!process.env.BASE_URL;

export default defineConfig({
  testDir: "./specs/e2e",
  // 원격 대상: DB 직접 접근하는 setup/teardown 스킵
  ...(isRemoteTarget
    ? {}
    : {
        globalSetup: "./specs/e2e/global-setup.ts",
        globalTeardown: "./specs/e2e/global-teardown.ts",
      }),
  timeout: isRemoteTarget ? 60_000 : 30_000,
  fullyParallel: false,
  workers: process.env.CI ? 4 : 4,
  retries: process.env.CI ? 2 : 1,
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // 원격 대상: 로컬 서버 기동하지 않음
  ...(isRemoteTarget
    ? {}
    : {
        webServer: {
          command: "node scripts/playwright-web-server.cjs",
          env: localServerEnv,
          url: baseURL,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        },
      }),
});
