#!/usr/bin/env node
/**
 * Pickket 정적 감사 스크립트
 *
 * 기본 사용:
 *   node scripts/audit.mjs
 *   node scripts/audit.mjs --strict
 *
 * 운영형 사용:
 *   node scripts/audit.mjs --changed
 *   node scripts/audit.mjs --staged
 *   node scripts/audit.mjs --baseline
 *   node scripts/audit.mjs --update-baseline
 *   node scripts/audit.mjs --format json --out audit-report.json
 *
 * 억제 주석:
 *   // audit-ignore: no-key-index
 *   // audit-ignore-next-line: no-key-index,no-console-log
 *   // audit-ignore-file: *
 */

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ─── 설정 ────────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASELINE_PATH = join(ROOT, ".audit-baseline.json");

const SEVERITY_ORDER = /** @type {const} */ ({
  CRITICAL: 3,
  WARNING: 2,
  INFO: 1,
});

const SCAN_TARGETS = [
  { dir: "apps/consumer/src", type: "frontend" },
  { dir: "apps/admin/src", type: "frontend" },
  { dir: "packages/lib/src", type: "frontend" },
  { dir: "packages/ui/src", type: "frontend" },
  { dir: "packages/store/src", type: "frontend" },
  { dir: "backend/app", type: "backend" },
  { dir: "engine/talkfile_engine", type: "backend" },
];

const SKIP_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)alembic\/versions(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)generated(\/|$)/,
  /\.tsbuildinfo$/,
];

const TEST_PATTERNS = [
  /(^|\/)__tests__(\/|$)/,
  /\.test\.(ts|tsx|js|jsx|py|mjs)$/,
  /\.spec\.(ts|tsx|js|jsx|py|mjs)$/,
  /(^|\/)tests(\/|$)/,
  /(^|\/)conftest\.py$/,
  /(^|\/)setupTests\./,
  /(^|\/)fixtures(\/|$)/,
  /playwright\.config\./,
];

const PUBLIC_API_ALLOWLIST = new Set([
  "backend/app/api/v1/auth.py",
  "backend/app/api/v1/health.py",
  "backend/app/api/v1/metrics.py",
  "backend/app/api/v1/password_reset.py",
  "backend/app/api/v1/payment_webhook.py",
  "backend/app/api/v1/public.py",
  "backend/app/api/v1/public_events.py",
  "backend/app/api/v1/time_slots.py",
  "backend/app/api/v1/venues.py",
]);

// ─── 타입 ────────────────────────────────────────────────────────────────────

/**
 * @typedef {'CRITICAL' | 'WARNING' | 'INFO'} Severity
 * @typedef {'frontend' | 'backend'} ScannerType
 * @typedef {{
 *   severity: Severity,
 *   rule: string,
 *   file: string,
 *   line: number,
 *   message: string,
 *   type: ScannerType
 * }} Finding
 *
 * @typedef {{
 *   strict: boolean,
 *   failOn: Severity | 'NONE',
 *   format: 'text' | 'json' | 'md',
 *   outPath: string | null,
 *   changed: boolean,
 *   staged: boolean,
 *   includeTests: boolean,
 *   maxFindings: number,
 *   baselinePath: string,
 *   useBaseline: boolean,
 *   updateBaseline: boolean,
 *   includeRules: Set<string>,
 *   excludeRules: Set<string>,
 * }} CliOptions
 */

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function toPosix(pathLike) {
  return pathLike.replaceAll("\\", "/");
}

function isTestFile(relPath) {
  return TEST_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isFrontend(relPath) {
  return /\.(ts|tsx|js|jsx|mjs)$/.test(relPath);
}

function isBackend(relPath) {
  return /\.py$/.test(relPath);
}

function severityMeetsThreshold(severity, threshold) {
  if (threshold === "NONE") return false;
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

function findingSignature(finding) {
  return [
    finding.severity,
    finding.rule,
    finding.file,
    finding.line,
    finding.message,
  ].join("|");
}

function sortFindings(a, b) {
  const severityDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (severityDiff !== 0) return severityDiff;
  const fileDiff = a.file.localeCompare(b.file);
  if (fileDiff !== 0) return fileDiff;
  if (a.line !== b.line) return a.line - b.line;
  return a.rule.localeCompare(b.rule);
}

function parseRuleList(raw) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseSuppressionDirective(line, directive) {
  const regex = new RegExp(`${directive}\\s*:\\s*([^\\n]+)`, "i");
  const match = line.match(regex);
  if (!match) return [];
  return parseRuleList(match[1]);
}

function getFileSuppressions(lines) {
  const suppressions = new Set();
  const scanWindow = lines.slice(0, 5);
  for (const line of scanWindow) {
    for (const rule of parseSuppressionDirective(line, "audit-ignore-file")) {
      suppressions.add(rule);
    }
  }
  return suppressions;
}

function isSuppressed(rule, lines, lineIndex, fileSuppressions) {
  if (fileSuppressions.has("*") || fileSuppressions.has(rule)) {
    return true;
  }

  const current = lines[lineIndex] ?? "";
  const previous = lines[lineIndex - 1] ?? "";

  const currentRules = parseSuppressionDirective(current, "audit-ignore");
  if (currentRules.includes("*") || currentRules.includes(rule)) {
    return true;
  }

  const previousRules = parseSuppressionDirective(previous, "audit-ignore-next-line");
  if (previousRules.includes("*") || previousRules.includes(rule)) {
    return true;
  }

  return false;
}

function isRuleEnabled(rule, options) {
  if (options.includeRules.size > 0 && !options.includeRules.has(rule)) {
    return false;
  }
  if (options.excludeRules.has(rule)) {
    return false;
  }
  return true;
}

function createEmitter(findings, relPath, type, lines, fileSuppressions, options) {
  return (severity, rule, line, message) => {
    if (!isRuleEnabled(rule, options)) return;
    if (isSuppressed(rule, lines, line - 1, fileSuppressions)) return;
    findings.push({ severity, rule, file: relPath, line, message, type });
  };
}

async function* walkDir(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = toPosix(relative(ROOT, fullPath));

    if (SKIP_PATTERNS.some((pattern) => pattern.test(relPath))) continue;

    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function getGitScopedFiles(options) {
  if (!options.changed && !options.staged) return null;

  const args = options.staged
    ? ["-C", ROOT, "diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]
    : ["-C", ROOT, "diff", "HEAD", "--name-only", "--diff-filter=ACMRTUXB"];

  try {
    const { stdout } = await execFileAsync("git", args, { cwd: ROOT });
    const files = stdout
      .split("\n")
      .map((line) => toPosix(line.trim()))
      .filter(Boolean);
    return new Set(files);
  } catch {
    return null;
  }
}

async function loadBaseline(path) {
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw);
    const entries = Array.isArray(data?.findings) ? data.findings : [];
    return new Set(entries.map((item) => item.signature).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function writeBaseline(path, findings) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    root: ROOT,
    findings: findings
      .slice()
      .sort(sortFindings)
      .map((finding) => ({
        signature: findingSignature(finding),
        severity: finding.severity,
        rule: finding.rule,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      })),
  };

  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function printHelp() {
  console.log(`
Pickket 정적 감사 스크립트

사용법:
  node scripts/audit.mjs [options]

옵션:
  --strict                  WARNING 이상이면 실패
  --fail-on <level>         실패 기준 (critical|warning|info|none)
  --changed                 git 변경 파일만 검사
  --staged                  git staged 파일만 검사
  --include-tests           테스트 파일도 경고/정보 스캔에 포함
  --format <type>           출력 형식 (text|json|md)
  --out <path>              결과를 파일로 저장
  --max-findings <n>        텍스트 출력 최대 개수 (기본 200)
  --baseline [path]         baseline 적용 (.audit-baseline.json 기본)
  --update-baseline [path]  현재 결과로 baseline 갱신 후 종료
  --rule <name>             특정 rule만 실행 (반복 가능)
  --exclude-rule <name>     특정 rule 제외 (반복 가능)
  --help                    도움말

억제 주석:
  // audit-ignore: no-key-index
  // audit-ignore-next-line: no-key-index,no-console-log
  // audit-ignore-file: *
`);
}

function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = {
    strict: false,
    failOn: "CRITICAL",
    format: "text",
    outPath: null,
    changed: false,
    staged: false,
    includeTests: false,
    maxFindings: 200,
    baselinePath: DEFAULT_BASELINE_PATH,
    useBaseline: false,
    updateBaseline: false,
    includeRules: new Set(),
    excludeRules: new Set(),
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--strict") {
      options.strict = true;
      options.failOn = "WARNING";
      continue;
    }

    if (arg === "--changed") {
      options.changed = true;
      continue;
    }

    if (arg === "--staged") {
      options.staged = true;
      continue;
    }

    if (arg === "--include-tests") {
      options.includeTests = true;
      continue;
    }

    if (arg === "--baseline") {
      options.useBaseline = true;
      if (args[0] && !args[0].startsWith("--")) {
        options.baselinePath = resolve(ROOT, args.shift());
      }
      continue;
    }

    if (arg.startsWith("--baseline=")) {
      options.useBaseline = true;
      options.baselinePath = resolve(ROOT, arg.slice("--baseline=".length));
      continue;
    }

    if (arg === "--update-baseline") {
      options.updateBaseline = true;
      options.useBaseline = true;
      if (args[0] && !args[0].startsWith("--")) {
        options.baselinePath = resolve(ROOT, args.shift());
      }
      continue;
    }

    if (arg.startsWith("--update-baseline=")) {
      options.updateBaseline = true;
      options.useBaseline = true;
      options.baselinePath = resolve(ROOT, arg.slice("--update-baseline=".length));
      continue;
    }

    if (arg === "--out") {
      options.outPath = resolve(ROOT, args.shift() ?? "");
      continue;
    }

    if (arg.startsWith("--out=")) {
      options.outPath = resolve(ROOT, arg.slice("--out=".length));
      continue;
    }

    if (arg === "--format") {
      const value = (args.shift() ?? "text").toLowerCase();
      if (value === "json" || value === "md" || value === "text") {
        options.format = value;
      }
      continue;
    }

    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length).toLowerCase();
      if (value === "json" || value === "md" || value === "text") {
        options.format = value;
      }
      continue;
    }

    if (arg === "--fail-on") {
      const value = (args.shift() ?? "critical").toUpperCase();
      if (value === "CRITICAL" || value === "WARNING" || value === "INFO" || value === "NONE") {
        options.failOn = value;
      }
      continue;
    }

    if (arg.startsWith("--fail-on=")) {
      const value = arg.slice("--fail-on=".length).toUpperCase();
      if (value === "CRITICAL" || value === "WARNING" || value === "INFO" || value === "NONE") {
        options.failOn = value;
      }
      continue;
    }

    if (arg === "--max-findings") {
      const value = Number(args.shift() ?? "200");
      if (Number.isFinite(value) && value > 0) {
        options.maxFindings = Math.trunc(value);
      }
      continue;
    }

    if (arg.startsWith("--max-findings=")) {
      const value = Number(arg.slice("--max-findings=".length));
      if (Number.isFinite(value) && value > 0) {
        options.maxFindings = Math.trunc(value);
      }
      continue;
    }

    if (arg === "--rule") {
      for (const rule of parseRuleList(args.shift() ?? "")) {
        options.includeRules.add(rule);
      }
      continue;
    }

    if (arg.startsWith("--rule=")) {
      for (const rule of parseRuleList(arg.slice("--rule=".length))) {
        options.includeRules.add(rule);
      }
      continue;
    }

    if (arg === "--exclude-rule") {
      for (const rule of parseRuleList(args.shift() ?? "")) {
        options.excludeRules.add(rule);
      }
      continue;
    }

    if (arg.startsWith("--exclude-rule=")) {
      for (const rule of parseRuleList(arg.slice("--exclude-rule=".length))) {
        options.excludeRules.add(rule);
      }
    }
  }

  return options;
}

// ─── 규칙 정의 ───────────────────────────────────────────────────────────────

/**
 * @param {string} relPath
 * @param {string} content
 * @param {string[]} lines
 * @param {(severity: Severity, rule: string, line: number, message: string) => void} emit
 * @param {CliOptions} options
 */
function checkFrontend(relPath, content, lines, emit, options) {
  const isTest = isTestFile(relPath);
  const skipWarnings = isTest && !options.includeTests;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    if (!isTest && /\beval\s*\(/.test(line) && !/['"`]eval['"`]/.test(line)) {
      emit("CRITICAL", "no-eval", lineNum, "eval() 사용 — 코드 인젝션 위험");
    }

    if (!isTest && /\bnew\s+Function\s*\(/.test(line)) {
      emit("CRITICAL", "no-new-function", lineNum, "new Function() 사용 — 코드 인젝션 위험");
    }

    if (!isTest && /dangerouslySetInnerHTML/.test(line)) {
      emit("CRITICAL", "no-dangerous-html", lineNum, "dangerouslySetInnerHTML 사용 — XSS 위험");
    }

    if (!isTest && /\.innerHTML\s*=/.test(line)) {
      emit("CRITICAL", "no-innerhtml-assign", lineNum, "innerHTML 직접 할당 — XSS 위험");
    }

    if (
      !isTest &&
      !relPath.includes(".env") &&
      !relPath.includes("config") &&
      !relPath.endsWith(".md")
    ) {
      const secretMatch = line.match(
        /(?:api[_-]?key|api[_-]?secret|secret[_-]?key)\s*[:=]\s*["'`]([^"'`]{8,})["'`]/i,
      );
      if (
        secretMatch &&
        !/process\.env/.test(line) &&
        !/NEXT_PUBLIC_/.test(line) &&
        !/example|placeholder|test|mock|dummy|change.in.production|dev/i.test(secretMatch[1]) &&
        !/error|message|label|placeholder|hint|validation/i.test(line)
      ) {
        emit("CRITICAL", "no-hardcoded-secret", lineNum, "하드코딩된 시크릿 감지");
      }
    }

    if (
      relPath.startsWith("apps/") &&
      !relPath.includes("api/") &&
      /process\.env\.(SECRET_|DATABASE_|REDIS_|CELERY_|PORTONE_API_SECRET)/.test(line)
    ) {
      emit(
        "CRITICAL",
        "no-server-env-client",
        lineNum,
        "서버 전용 환경변수가 클라이언트 코드에 노출",
      );
    }

    if (skipWarnings) continue;

    if (/key\s*=\s*\{(?:index|idx|i)\}/.test(line)) {
      const context = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      const isLoadingSkeleton = /loading\.(tsx|ts)$/.test(relPath);
      const isFixedArray = /Array\.from|Array\(\d+\)\.fill/.test(context);
      const isUnusedData = /\.map\(\s*\(\s*_\s*,/.test(context);
      const isStaticConst = /const\s+\w+\s*=\s*\[[\s\S]{0,200}$/m.test(context);

      if (!isLoadingSkeleton && !isFixedArray && !isUnusedData && !isStaticConst) {
        emit("WARNING", "no-key-index", lineNum, "key={index} — 리스트 재렌더링 버그 위험");
      }
    }

    if (/\bcatch\s*(\([^)]*\))?\s*\{/.test(trimmed)) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine === "}" || nextLine === "} catch" || nextLine === "} finally {") {
        emit("WARNING", "no-empty-catch", lineNum, "빈 catch 블록 — 에러 무시됨");
      }
    }

    if (/\bas\s+unknown\s+as\b/.test(line)) {
      emit("WARNING", "no-double-assertion", lineNum, "as unknown as 이중 타입 단언 — 타입 안전성 우회");
    }

    if (/\bconsole\.log\s*\(/.test(line)) {
      emit("WARNING", "no-console-log", lineNum, "console.log 운영 잔류");
    }

    if (/\bfetch\s*\(/.test(line)) {
      const context = lines.slice(i, i + 15).join("\n");
      if (!/\.ok\b/.test(context) && !/response\.status|res\.status/.test(context) && !/assertOk|ensureOk/.test(context)) {
        emit("WARNING", "fetch-check-ok", lineNum, "fetch 응답 .ok 검증 누락");
      }
    }

    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line) && !/\/\/\s*eslint/.test(line)) {
      const tag = line.match(/\b(TODO|FIXME|HACK|XXX)\b/)?.[1] ?? "TODO";
      emit("WARNING", "no-todo-fixme", lineNum, `${tag} 주석 잔류`);
    }

    if (
      /["'`]https?:\/\/localhost/.test(line) &&
      !/process\.env/.test(line) &&
      !/fallback|default|example/i.test(line) &&
      !relPath.includes("config") &&
      !relPath.includes(".env") &&
      !relPath.endsWith("proxy.ts") &&
      !relPath.includes("playwright") &&
      !relPath.includes("vitest")
    ) {
      if (!/\|\|/.test(line) && !/\?\?/.test(line)) {
        emit("WARNING", "no-hardcoded-localhost", lineNum, "localhost URL 하드코딩");
      }
    }

    if (
      !isTest &&
      /process\.env\.NEXT_PUBLIC_[A-Z0-9_]+\s*(\|\||\?\?)\s*["'`]https?:\/\/localhost/.test(line)
    ) {
      emit(
        "INFO",
        "public-env-localhost-fallback",
        lineNum,
        "NEXT_PUBLIC_* 가 localhost fallback을 가짐 — 운영 빌드 변수 누락 시 오동작 가능",
      );
    }

    if (/catch\s*\(\s*\w+\s*:\s*any\s*\)/.test(line)) {
      emit("WARNING", "no-catch-any", lineNum, "catch(err: any) — 타입 불명확");
    }
  }

  if (!isTest && lines.length > 500) {
    emit("INFO", "large-file", 1, `파일이 ${lines.length}줄 — 분할 검토 필요`);
  }

  if (!isTest) {
    let anyCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/\bas\s+any\b/.test(line)) anyCount++;
    }
    if (anyCount >= 3) {
      emit("INFO", "type-debt-any", 1, `as any ${anyCount}회 사용 — 타입 부채`);
    }
  }
}

/**
 * @param {string} relPath
 * @param {string} content
 * @param {string[]} lines
 * @param {(severity: Severity, rule: string, line: number, message: string) => void} emit
 * @param {CliOptions} options
 */
function checkBackend(relPath, content, lines, emit, options) {
  const isTest = isTestFile(relPath);
  const skipWarnings = isTest && !options.includeTests;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) continue;

    if (
      /f["'].*\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(line) &&
      !/comment|log|debug|print|docstring/i.test(line)
    ) {
      emit("CRITICAL", "no-sql-interpolation", lineNum, "SQL f-string 보간 — SQL 인젝션 위험");
    }

    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line) && /\.format\s*\(.*\)/.test(line)) {
      emit("CRITICAL", "no-sql-format", lineNum, "SQL .format() 보간 — SQL 인젝션 위험");
    }

    if (
      /\beval\s*\(/.test(line) &&
      !/import/.test(line) &&
      !isTest &&
      !/(?:redis|r|self\.redis|await\s+\w+)\.eval\s*\(/.test(line)
    ) {
      emit("CRITICAL", "no-eval-py", lineNum, "eval() 사용 — 코드 인젝션 위험");
    }

    if (!relPath.includes("test") && !relPath.includes("config") && !relPath.endsWith(".env")) {
      const secretMatch = line.match(
        /(?:api_key|api_secret|token|password|secret_key)\s*=\s*["']([^"']{8,})["']/i,
      );
      if (
        secretMatch &&
        !/os\.environ|os\.getenv|settings\.|config\.|example|test|mock|dev|change/i.test(line)
      ) {
        emit("CRITICAL", "no-hardcoded-secret-py", lineNum, "하드코딩된 시크릿 감지");
      }
    }

    if (
      !isTest &&
      relPath.includes("api/") &&
      /(?:HTTPException|api_error).*str\(\w+\)/.test(line)
    ) {
      emit(
        "INFO",
        "raw-exception-detail",
        lineNum,
        "str(e) 에러 메시지 — production 필터링 동작 확인 권장",
      );
    }

    if (skipWarnings) continue;

    const nextLine = lines[i + 1]?.trim() ?? "";
    const nextLines = lines.slice(i + 1, i + 5).join("\n");
    const isExceptPass = /\bexcept\b.*:/.test(trimmed) && (nextLine === "pass" || nextLine === "...");

    if (isExceptPass) {
      const surrounding = lines.slice(Math.max(0, i - 5), i + 5).join("\n");
      if (!/log|logger|sentry/.test(surrounding)) {
        emit("WARNING", "no-bare-except-pass", lineNum, "except + pass — 에러 무시됨");
      }
    }

    if (
      !isExceptPass &&
      (/\bexcept\s*:/.test(trimmed) || /\bexcept\s+Exception(?:\s+as\s+\w+)?\s*:/.test(trimmed))
    ) {
      if (!/log|logger|sentry|print|raise/.test(nextLines)) {
        emit("WARNING", "no-broad-except", lineNum, "broad except — 예외 범위가 너무 넓음");
      }
    }

    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
      const tag = line.match(/\b(TODO|FIXME|HACK|XXX)\b/)?.[1] ?? "TODO";
      emit("WARNING", "no-todo-fixme-py", lineNum, `${tag} 주석 잔류`);
    }
  }

  if (!isTest && lines.length > 500) {
    emit("INFO", "large-file-py", 1, `파일이 ${lines.length}줄 — 분할 검토 필요`);
  }

  if (
    !isTest &&
    relPath.includes("api/v1/") &&
    !relPath.includes("__init__") &&
    !PUBLIC_API_ALLOWLIST.has(relPath)
  ) {
    const hasAuth = /Depends\s*\(\s*(get_current_user|get_current_organizer|get_current_admin|get_current_user_optional|require_scope|rate_limit)/m.test(
      content,
    );
    if (!hasAuth && /\b(router|app)\.(get|post|put|patch|delete)\b/m.test(content)) {
      emit(
        "INFO",
        "check-auth-dependency",
        1,
        "API 라우터에 인증 의존성이 보이지 않음 — 의도된 공개 API인지 확인 필요",
      );
    }
  }
}

// ─── 보고서 ──────────────────────────────────────────────────────────────────

function buildSummary(findings) {
  const byRule = new Map();
  const byFile = new Map();

  for (const finding of findings) {
    byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  }

  const topRules = [...byRule.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));

  const topFiles = [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  return { topRules, topFiles };
}

function formatTextReport({
  options,
  startTime,
  elapsed,
  scannedFiles,
  frontendFiles,
  backendFiles,
  findings,
  visibleFindings,
  suppressedByBaseline,
  scanMode,
  summary,
}) {
  const criticals = findings.filter((f) => f.severity === "CRITICAL");
  const warnings = findings.filter((f) => f.severity === "WARNING");
  const infos = findings.filter((f) => f.severity === "INFO");
  const now = new Date(startTime).toISOString().replace("T", " ").slice(0, 19);

  const colors = {
    CRITICAL: "\x1b[31m",
    WARNING: "\x1b[33m",
    INFO: "\x1b[36m",
    GREEN: "\x1b[32m",
    RESET: "\x1b[0m",
  };

  const lines = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              Pickket 정적 감사 스크립트                     ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`  모드:       ${options.strict ? "STRICT" : "DEFAULT"} / fail-on=${options.failOn}`);
  lines.push(`  범위:       ${scanMode}`);
  lines.push(`  검사 시각:  ${now}`);
  lines.push(`  소요 시간:  ${elapsed}s`);
  lines.push(`  총 파일:    ${scannedFiles} (프론트 ${frontendFiles} / 백엔드 ${backendFiles})`);
  if (options.useBaseline) {
    lines.push(`  baseline:   ${relative(ROOT, options.baselinePath)}`);
    lines.push(`  baseline suppress: ${suppressedByBaseline}`);
  }
  lines.push("");

  lines.push("  Top Rules:");
  if (summary.topRules.length === 0) {
    lines.push("    없음");
  } else {
    for (const item of summary.topRules) {
      lines.push(`    ${item.rule.padEnd(28)} ${item.count}`);
    }
  }
  lines.push("");

  lines.push("  Top Files:");
  if (summary.topFiles.length === 0) {
    lines.push("    없음");
  } else {
    for (const item of summary.topFiles) {
      lines.push(`    ${item.file} (${item.count})`);
    }
  }
  lines.push("");

  const grouped = {
    CRITICAL: visibleFindings.filter((f) => f.severity === "CRITICAL"),
    WARNING: visibleFindings.filter((f) => f.severity === "WARNING"),
    INFO: visibleFindings.filter((f) => f.severity === "INFO"),
  };

  for (const severity of /** @type {Severity[]} */ (["CRITICAL", "WARNING", "INFO"])) {
    const items = grouped[severity];
    if (items.length === 0) continue;
    lines.push(`${colors[severity]}── ${severity} (${items.length}) ──${colors.RESET}`);
    lines.push("");
    for (const finding of items) {
      lines.push(`  ${colors[severity]}[${finding.severity}]${colors.RESET} ${finding.rule}`);
      lines.push(`    ${finding.file}:${finding.line}`);
      lines.push(`    ${finding.message}`);
      lines.push("");
    }
  }

  if (visibleFindings.length < findings.length) {
    lines.push(`  ... ${findings.length - visibleFindings.length}건 생략 (--max-findings=${options.maxFindings})`);
    lines.push("");
  }

  lines.push("────────────────────────────────────────────────────────────────");
  lines.push(
    `  합계: CRITICAL ${criticals.length} | WARNING ${warnings.length} | INFO ${infos.length}`,
  );
  lines.push("────────────────────────────────────────────────────────────────");

  const failed = findings.some((finding) => severityMeetsThreshold(finding.severity, options.failOn));
  lines.push("");
  lines.push(
    failed
      ? `  ${colors.CRITICAL}✗ 감사 실패${colors.RESET}`
      : `  ${colors.GREEN}✓ 감사 통과${colors.RESET}`,
  );

  return lines.join("\n");
}

function formatMarkdownReport({
  options,
  elapsed,
  scannedFiles,
  frontendFiles,
  backendFiles,
  findings,
  suppressedByBaseline,
  scanMode,
  summary,
}) {
  const criticals = findings.filter((f) => f.severity === "CRITICAL").length;
  const warnings = findings.filter((f) => f.severity === "WARNING").length;
  const infos = findings.filter((f) => f.severity === "INFO").length;

  const lines = [];
  lines.push("# Pickket Audit Report");
  lines.push("");
  lines.push(`- Mode: ${options.strict ? "STRICT" : "DEFAULT"} / fail-on=${options.failOn}`);
  lines.push(`- Scope: ${scanMode}`);
  lines.push(`- Elapsed: ${elapsed}s`);
  lines.push(`- Files: ${scannedFiles} (frontend ${frontendFiles} / backend ${backendFiles})`);
  if (options.useBaseline) {
    lines.push(`- Baseline: ${relative(ROOT, options.baselinePath)}`);
    lines.push(`- Baseline suppressions: ${suppressedByBaseline}`);
  }
  lines.push(`- Totals: CRITICAL ${criticals} / WARNING ${warnings} / INFO ${infos}`);
  lines.push("");

  lines.push("## Top Rules");
  lines.push("");
  for (const item of summary.topRules) {
    lines.push(`- ${item.rule}: ${item.count}`);
  }
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  for (const finding of findings.slice(0, options.maxFindings)) {
    lines.push(`- **${finding.severity}** \`${finding.rule}\` ${finding.file}:${finding.line} — ${finding.message}`);
  }
  if (findings.length > options.maxFindings) {
    lines.push(`- ... ${findings.length - options.maxFindings} more findings omitted`);
  }

  return `${lines.join("\n")}\n`;
}

function formatJsonReport(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ─── 메인 실행 ───────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startTime = Date.now();
  const scopedFiles = await getGitScopedFiles(options);
  const baselineSignatures = options.useBaseline ? await loadBaseline(options.baselinePath) : new Set();

  /** @type {Finding[]} */
  const rawFindings = [];
  let scannedFiles = 0;
  let frontendFiles = 0;
  let backendFiles = 0;

  for (const target of SCAN_TARGETS) {
    const dir = join(ROOT, target.dir);
    for await (const filePath of walkDir(dir)) {
      const relPath = toPosix(relative(ROOT, filePath));
      if (scopedFiles && !scopedFiles.has(relPath)) continue;

      let content;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      if (
        (target.type === "frontend" && !isFrontend(relPath)) ||
        (target.type === "backend" && !isBackend(relPath))
      ) {
        continue;
      }

      const lines = content.split("\n");
      const fileSuppressions = getFileSuppressions(lines);
      const emit = createEmitter(rawFindings, relPath, target.type, lines, fileSuppressions, options);

      scannedFiles++;
      if (target.type === "frontend") frontendFiles++;
      if (target.type === "backend") backendFiles++;

      if (target.type === "frontend") {
        checkFrontend(relPath, content, lines, emit, options);
      } else {
        checkBackend(relPath, content, lines, emit, options);
      }
    }
  }

  rawFindings.sort(sortFindings);

  if (options.updateBaseline) {
    await writeBaseline(options.baselinePath, rawFindings);
    console.log(`baseline updated: ${relative(ROOT, options.baselinePath)} (${rawFindings.length} findings)`);
    process.exit(0);
  }

  const findings = rawFindings.filter((finding) => !baselineSignatures.has(findingSignature(finding)));
  const suppressedByBaseline = rawFindings.length - findings.length;
  const visibleFindings = findings.slice(0, options.maxFindings);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const scanMode = options.staged
    ? "staged files"
    : options.changed
      ? "git changed files"
      : "full scan";
  const summary = buildSummary(findings);

  const jsonPayload = {
    mode: options.strict ? "STRICT" : "DEFAULT",
    failOn: options.failOn,
    scope: scanMode,
    elapsedSeconds: Number(elapsed),
    files: {
      total: scannedFiles,
      frontend: frontendFiles,
      backend: backendFiles,
    },
    baseline: options.useBaseline
      ? {
          path: relative(ROOT, options.baselinePath),
          suppressed: suppressedByBaseline,
        }
      : null,
    totals: {
      CRITICAL: findings.filter((f) => f.severity === "CRITICAL").length,
      WARNING: findings.filter((f) => f.severity === "WARNING").length,
      INFO: findings.filter((f) => f.severity === "INFO").length,
    },
    summary,
    findings,
  };

  let report;
  if (options.format === "json") {
    report = formatJsonReport(jsonPayload);
  } else if (options.format === "md") {
    report = formatMarkdownReport({
      options,
      elapsed,
      scannedFiles,
      frontendFiles,
      backendFiles,
      findings,
      suppressedByBaseline,
      scanMode,
      summary,
    });
  } else {
    report = formatTextReport({
      options,
      startTime,
      elapsed,
      scannedFiles,
      frontendFiles,
      backendFiles,
      findings,
      visibleFindings,
      suppressedByBaseline,
      scanMode,
      summary,
    });
  }

  if (options.outPath) {
    await writeFile(options.outPath, report, "utf-8");
  }

  process.stdout.write(report);

  const failed = findings.some((finding) => severityMeetsThreshold(finding.severity, options.failOn));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("감사 스크립트 실행 오류:", err);
  process.exit(2);
});
