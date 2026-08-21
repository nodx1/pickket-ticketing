import fs from "node:fs";
import path from "node:path";

/** Load .env.local only for explicit operator scripts; never overwrites exports. */
export function loadLocalEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

export function redact(value: string, visible = 0): string {
  if (visible <= 0) return "[redacted]";
  return value.length <= visible ? "[redacted]" : `${value.slice(0, visible)}…[redacted]`;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

export function parsePositiveInt(name: string, fallback: number, max = 100): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
}
