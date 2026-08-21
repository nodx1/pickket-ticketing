#!/usr/bin/env node
/**
 * i18n 번역 키 검증 스크립트
 *
 * ko.json을 기준으로 다른 언어 파일의 누락/초과/빈 문자열 키를 검출합니다.
 * 누락이 있으면 exit code 1로 종료합니다.
 */

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.resolve(
  __dirname,
  "../apps/consumer/messages"
);

const BASE_LOCALE = "ko";
const LOCALE_FILES = ["ko.json", "en.json", "ja.json", "zh-CN.json", "fr.json"];

/**
 * Flatten a nested object into dot-notation keys.
 * e.g. { a: { b: "hello" } } => { "a.b": "hello" }
 */
function flattenKeys(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenKeys(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function loadLocale(filename) {
  const filePath = path.join(MESSAGES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`  [ERROR] File not found: ${filePath}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`  [ERROR] Failed to parse ${filename}: ${err.message}`);
    return null;
  }
}

function main() {
  console.log("=== i18n Translation Key Validation ===\n");
  console.log(`Base locale: ${BASE_LOCALE}`);
  console.log(`Messages dir: ${MESSAGES_DIR}\n`);

  // Load base locale
  const baseRaw = loadLocale(`${BASE_LOCALE}.json`);
  if (!baseRaw) {
    console.error("Failed to load base locale. Aborting.");
    process.exit(1);
  }

  const baseKeys = flattenKeys(baseRaw);
  const baseKeySet = new Set(Object.keys(baseKeys));
  console.log(`Base locale (${BASE_LOCALE}) keys: ${baseKeySet.size}\n`);

  let hasErrors = false;

  for (const file of LOCALE_FILES) {
    const locale = file.replace(".json", "");
    if (locale === BASE_LOCALE) continue;

    console.log(`--- ${locale} (${file}) ---`);

    const raw = loadLocale(file);
    if (!raw) {
      hasErrors = true;
      continue;
    }

    const localeKeys = flattenKeys(raw);
    const localeKeySet = new Set(Object.keys(localeKeys));

    // Missing keys (in base but not in this locale)
    const missing = [];
    for (const key of baseKeySet) {
      if (!localeKeySet.has(key)) {
        missing.push(key);
      }
    }

    // Extra keys (in this locale but not in base)
    const extra = [];
    for (const key of localeKeySet) {
      if (!baseKeySet.has(key)) {
        extra.push(key);
      }
    }

    // Empty string values
    const empty = [];
    for (const [key, value] of Object.entries(localeKeys)) {
      if (value === "") {
        empty.push(key);
      }
    }

    if (missing.length === 0 && extra.length === 0 && empty.length === 0) {
      console.log(`  OK: All ${localeKeySet.size} keys match base locale.\n`);
      continue;
    }

    if (missing.length > 0) {
      hasErrors = true;
      console.log(`  MISSING (${missing.length} keys not in ${locale}):`);
      for (const key of missing.slice(0, 20)) {
        console.log(`    - ${key}`);
      }
      if (missing.length > 20) {
        console.log(`    ... and ${missing.length - 20} more`);
      }
    }

    if (extra.length > 0) {
      console.log(`  EXTRA (${extra.length} keys only in ${locale}, not in ${BASE_LOCALE}):`);
      for (const key of extra.slice(0, 20)) {
        console.log(`    - ${key}`);
      }
      if (extra.length > 20) {
        console.log(`    ... and ${extra.length - 20} more`);
      }
    }

    if (empty.length > 0) {
      hasErrors = true;
      console.log(`  EMPTY VALUES (${empty.length} keys with empty string ""):`);
      for (const key of empty.slice(0, 20)) {
        console.log(`    - ${key}`);
      }
      if (empty.length > 20) {
        console.log(`    ... and ${empty.length - 20} more`);
      }
    }

    console.log();
  }

  // Summary
  console.log("=== Summary ===");
  if (hasErrors) {
    console.log("FAIL: Missing or empty translation keys detected.");
    process.exit(1);
  } else {
    console.log("PASS: All translation keys are consistent across locales.");
    process.exit(0);
  }
}

main();
