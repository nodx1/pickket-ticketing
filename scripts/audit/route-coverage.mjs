#!/usr/bin/env node
/**
 * 저니 카탈로그 ↔ 실제 라우트 대조 (프론트엔드 감사 P1).
 *
 * ## 왜 스크립트인가
 * 2026-08-02 에 손으로 대조하다 **두 번 틀렸다**:
 *   ① consumer 경로의 `[locale]` 접두를 빼고 찾아 12개를 "사라진 저니" 로 오판
 *   ② `{a,b}` 를 콤마로 먼저 쪼개, 커버된 경로를 미커버로 집계
 * 두 번 다 **숫자가 이상해서** 알아챘다. 안 이상했으면 그대로 보고했을 것이다.
 *
 * ⟹ 커버리지 수치는 파서 버그로 쉽게 거짓이 된다. 매 라운드 이 스크립트로 다시 잰다.
 *
 * ## 쓰는 법
 *     node scripts/audit/route-coverage.mjs            # 표 출력
 *     node scripts/audit/route-coverage.mjs --strict   # 미커버가 있으면 exit 1
 *
 * `--strict` 는 CI·감사 게이트용이다. 새 화면을 만들고 카탈로그에 안 넣으면 실패한다 —
 * 그게 이 스크립트의 본체다(오늘 발견한 구멍 135개가 그렇게 쌓였다).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const STANDARD = path.join(ROOT, "docs/FRONTEND_AUDIT_STANDARD.md");
const APPS = {
  organizer: "organizer/src/app",
  consumer: "platform/apps/consumer/src/app",
  admin: "platform/apps/admin/src/app",
};

/** `page.tsx` 를 전수 수집해 라우트 경로로 만든다. 라우트 그룹 `(x)` 는 URL 에 안 나온다. */
function collectRoutes(appDir) {
  const base = path.join(ROOT, appDir);
  const out = new Set();
  if (!fs.existsSync(base)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name === "page.tsx") {
        const rel = path.relative(base, path.dirname(f)).split(path.sep);
        out.add("/" + rel.filter((s) => !/^\(.*\)$/.test(s)).join("/"));
      }
    }
  };
  walk(base);
  return out;
}

/**
 * 비교용 정규화.
 * ⚠️ consumer 는 실제 경로에 `/[locale]` 접두가 붙지만 카탈로그는 생략한다 — 여기서 벗긴다.
 * ⚠️ 동적 구간 이름은 앱마다 다르다(`[id]` vs `[eventId]`) → `§` 로 통일한다.
 */
function normalize(route) {
  const r = (route.replace(/^\/\[locale\]/, "") || "/").replace(/\[[^\]]+\]/g, "§");
  return r.length > 1 ? r.replace(/\/$/, "") : "/";
}

/** `/a/{b,c}` → `['/a/b','/a/c']`. **콤마 분리보다 먼저** 해야 한다(그 순서를 틀려 오집계했다). */
function expandBraces(token) {
  const m = /\{([^}]*)\}/.exec(token);
  if (!m) return [token];
  return m[1].split(",").map((o) => token.slice(0, m.index) + o.trim() + token.slice(m.index + m[0].length));
}

function catalogPaths(md) {
  // 저니 행: | ID | 이름 | 핵심 화면 | 도메인 |
  // ⚠️ 행 **전체**를 본다. 표가 3열인 저니(S-J1·X-J1)는 경로가 두 번째 칸에 있어,
  //    "세 번째 칸" 만 보면 놓친다(실측: `/staff/checkin` 을 그렇게 놓쳤다).
  const rows = [...md.matchAll(/^\|\s*(?:\*\*)?([FOAS]-J\d+|X-J1)(?:\*\*)?\s*(?:★|💰)?\s*\|(.*)$/gm)];
  const byApp = { organizer: new Set(), consumer: new Set(), admin: new Set() };
  for (const [, id, screens] of rows) {
    // 백틱 구간을 **같은 길이의 공백**으로 가린 사본 — 앱 귀속 판정은 이걸로만 본다.
    // (먼저 자르고 지우면 백틱 짝이 잘려 안 지워진다. 실측으로 그 함정을 밟았다.)
    const masked = screens.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    // ID 접두로 기본 앱을 정하되, 셀 안에 앱 이름이 적혀 있으면 그쪽으로 넣는다(앱을 넘나드는 저니).
    const fallback = id.startsWith("F") ? "consumer" : id.startsWith("A") ? "admin" : "organizer";
    for (const [, quoted] of screens.matchAll(/`([^`]+)`/g)) {
      // 백틱 **직전** 텍스트에 앱 이름이 있으면 그 앱으로 귀속(예: organizer `/tickets/[t]`)
      // ⚠️ 앞의 **경로 안 글자**에 속으면 안 된다 — `/for-organizers` 의 "organizer" 를
      //    앱 표시로 읽어 `/government` 를 organizer 로 잘못 귀속시켰다(실측).
      //    백틱으로 감싼 구간을 지운 뒤에 본다.
      const at = screens.indexOf("`" + quoted + "`");
      const before = masked.slice(Math.max(0, at - 24), at);
      const app = /organizer/.test(before) ? "organizer"
        : /consumer/.test(before) ? "consumer"
        : /admin/.test(before) ? "admin" : fallback;
      for (const tok of expandBraces(quoted.trim())) {
        for (const raw of tok.split(/[,·\s]+/)) {
          const one = raw.trim().replace(/^\(public\)/, "");
          if (!one.startsWith("/")) continue;
          byApp[app].add(one);
        }
      }
    }
  }
  return { byApp, journeyCount: rows.length };
}

const md = fs.readFileSync(STANDARD, "utf8");
const { byApp, journeyCount } = catalogPaths(md);

let total = 0;
let covered = 0;
const holes = [];
for (const [app, dir] of Object.entries(APPS)) {
  const routes = new Set([...collectRoutes(dir)].map(normalize));
  const claimed = new Set();
  for (const p of byApp[app]) {
    if (p.endsWith("/*")) {
      const pre = normalize(p.slice(0, -2));
      for (const r of routes) if (r === pre || r.startsWith(pre + "/")) claimed.add(r);
    } else claimed.add(normalize(p));
  }
  const hit = [...routes].filter((r) => claimed.has(r));
  const miss = [...routes].filter((r) => !claimed.has(r)).sort();
  total += routes.size;
  covered += hit.length;
  console.log(`  ${app.padEnd(10)} ${String(hit.length).padStart(3)}/${String(routes.size).padStart(3)}   미커버 ${miss.length}`);
  for (const m of miss) holes.push(`${app}  ${m}`);
}
console.log(`  ${"합계".padEnd(9)} ${String(covered).padStart(3)}/${String(total).padStart(3)}   (${Math.floor((covered * 100) / total)}%)   저니 ${journeyCount}개`);

if (holes.length) {
  console.log("\n🔴 어떤 저니에도 속하지 않는 화면 — FRONTEND_AUDIT_STANDARD.md §4 에 넣을 것:");
  for (const h of holes) console.log("   " + h);
}
if (process.argv.includes("--strict") && holes.length) process.exit(1);
