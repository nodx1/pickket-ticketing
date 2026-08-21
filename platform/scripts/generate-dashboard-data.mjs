/**
 * generate-dashboard-data.mjs
 *
 * 코드베이스를 스캔해서 페이지/엔드포인트/커밋 정보를 자동 추출합니다.
 * 출력: apps/admin/src/app/dev/_data/generated.json
 *
 * 실행: node scripts/generate-dashboard-data.mjs
 */

import { readdir, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "apps/admin/src/app/dev/_data/generated.json");

// ── 1. Next.js App Router 라우트 스캔 ──────────────────────────────────────
async function scanRoutes(appDir, appName) {
  if (!existsSync(appDir)) return 0;

  let count = 0;
  const pageFiles = new Set(["page.tsx", "page.ts", "page.jsx", "page.js"]);

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip _components, _data, _lib, (private) utility folders
        if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
        await walk(join(dir, entry.name));
      } else if (pageFiles.has(entry.name)) {
        count++;
      }
    }
  }

  await walk(appDir);
  return count;
}

// ── 2. FastAPI 엔드포인트 스캔 ─────────────────────────────────────────────
async function scanEndpoints(apiDir) {
  if (!existsSync(apiDir)) return 0;

  let count = 0;
  const routerPattern = /@router\.(get|post|patch|put|delete)\s*\(/gi;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === ".venv") continue;
        await walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".py")) {
        const { readFile } = await import("fs/promises");
        const content = await readFile(join(dir, entry.name), "utf-8").catch(() => "");
        const matches = content.match(routerPattern) ?? [];
        count += matches.length;
      }
    }
  }

  await walk(apiDir);
  return count;
}

// ── 3. 문서 파일 스캔 ────────────────────────────────────────────────────
async function scanDocs(docsDir) {
  if (!existsSync(docsDir)) return 0;

  let count = 0;

  async function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "archive") continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".html")) {
        count++;
      }
    }
  }

  await walk(docsDir);
  return count;
}

// ── 4. Git 정보 ────────────────────────────────────────────────────────────
function getGitInfo() {
  try {
    const commit = execSync("git -C " + ROOT + " log -1 --format=%H", { encoding: "utf-8" }).trim();
    const shortHash = commit.slice(0, 7);
    const message = execSync("git -C " + ROOT + " log -1 --format=%s", { encoding: "utf-8" }).trim();
    const author = execSync("git -C " + ROOT + " log -1 --format=%an", { encoding: "utf-8" }).trim();
    const date = execSync("git -C " + ROOT + " log -1 --format=%aI", { encoding: "utf-8" }).trim();
    return { hash: shortHash, fullHash: commit, message, author, date };
  } catch {
    return { hash: "unknown", fullHash: "unknown", message: "", author: "", date: "" };
  }
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔍 코드베이스 스캔 중...\n");

  const [consumerCount, adminCount, endpointCount, docCount] = await Promise.all([
    scanRoutes(join(ROOT, "apps/consumer/src/app"), "consumer"),
    scanRoutes(join(ROOT, "apps/admin/src/app"), "admin"),
    scanEndpoints(join(ROOT, "backend/app/api")),
    scanDocs(join(ROOT, "docs")),
  ]);

  const gitInfo = getGitInfo();

  const result = {
    generatedAt: new Date().toISOString(),
    routeCounts: {
      consumer: consumerCount,
      admin: adminCount,
      total: consumerCount + adminCount,
    },
    endpointCount,
    docCount,
    lastCommit: gitInfo,
  };

  await writeFile(OUT, JSON.stringify(result, null, 2), "utf-8");

  console.log("📊 스캔 결과:");
  console.log(`  Consumer pages : ${consumerCount}`);
  console.log(`  Admin pages    : ${adminCount}`);
  console.log(`  Total pages    : ${result.routeCounts.total}`);
  console.log(`  API endpoints  : ${endpointCount}`);
  console.log(`  Docs files     : ${docCount}`);
  console.log(`  Last commit    : ${gitInfo.hash} — ${gitInfo.message}`);
  console.log(`\n✅ 출력: ${OUT}`);
}

main().catch(err => {
  console.error("❌ 오류:", err);
  process.exit(1);
});
