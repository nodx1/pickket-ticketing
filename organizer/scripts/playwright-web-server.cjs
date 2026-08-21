const { existsSync, readFileSync, cpSync } = require("node:fs");
const path = require("node:path");

/**
 * Next.js standalone 산출물은 `.next/static` 과 `public/` 을 자동 포함하지 않는다.
 * (프로덕션 Dockerfile 은 runner 스테이지에서 COPY 로 해결하지만, 로컬 테스트는
 *  standalone server.js 를 직접 실행하므로 여기서 동일하게 복사해줘야 한다.)
 * 누락 시 모든 `_next/static/*` 청크가 404 + text/plain 으로 서빙되어 클라이언트
 * JS/CSS 가 로드되지 않고 스모크 테스트가 콘솔 에러로 실패한다.
 */
function syncStandaloneAssets() {
  const cwd = process.cwd();
  const copies = [
    [path.join(cwd, ".next/static"), path.join(cwd, ".next/standalone/.next/static")],
    [path.join(cwd, "public"), path.join(cwd, ".next/standalone/public")],
  ];
  for (const [src, dest] of copies) {
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }
}

function loadEnvFile(fileName) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) {
    return;
  }

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
    if (!key || process.env[key]) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(".env.local");

process.env.PLAYWRIGHT_TEST = "1";
process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
// playwright.config 는 PLAYWRIGHT_PORT 로 baseURL 을 잡는다. webServer 포트도 이를 따라야
// baseURL 과 일치한다(불일치 시 전 테스트가 잘못된 포트로 요청 → net::ERR/전수 실패).
process.env.PORT = process.env.PORT || process.env.PLAYWRIGHT_PORT || "3011";
process.env.TOSS_WEBHOOK_SECRET =
  process.env.TOSS_WEBHOOK_SECRET || "test_toss_webhook_secret";
process.env.KAKAO_WEBHOOK_SECRET =
  process.env.KAKAO_WEBHOOK_SECRET || "test_kakao_webhook_secret";
process.env.NAVER_WEBHOOK_SECRET =
  process.env.NAVER_WEBHOOK_SECRET || "test_naver_webhook_secret";
process.env.PORTONE_WEBHOOK_SECRET =
  process.env.PORTONE_WEBHOOK_SECRET || "test_portone_webhook_secret";
process.env.PORTONE_WEBHOOK_ENABLED =
  process.env.PORTONE_WEBHOOK_ENABLED || "true";
process.env.PLAYWRIGHT_TEST_RATE_LIMIT =
  process.env.PLAYWRIGHT_TEST_RATE_LIMIT || "disabled";

// standalone 실행 전 정적 자산 동기화 (static/public 누락 시 404 방지)
syncStandaloneAssets();

require(path.join(process.cwd(), ".next/standalone/server.js"));
