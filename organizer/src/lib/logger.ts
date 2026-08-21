type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

const currentLevel = parseLogLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel) {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

// PII 마스킹 — 로그에 개인정보(전화·이메일)가 평문으로 남지 않게 한다.
// 전화: 010****5678, 이메일: ab***@domain. 대상 키는 이름 휴리스틱으로 판별.
const PII_KEY = /(phone|mobile|tel|contact|buyer_?phone|buyer_?email|email|address|recipient|^to$)/i;
const SECRET_KEY = /(claim_?token|idempotency_?key|authorization|cookie|cron_?secret|secret|password|access_?key|session_?token)/i;

function maskPhone(v: string): string {
  const d = v.replace(/[^0-9]/g, "");
  if (d.length < 7) return v.length <= 2 ? "**" : `${v.slice(0, 2)}****`;
  return `${d.slice(0, 3)}****${d.slice(-4)}`;
}

function maskEmail(v: string): string {
  const at = v.indexOf("@");
  if (at <= 0) return v;
  const head = v.slice(0, Math.min(2, at));
  return `${head}***${v.slice(at)}`;
}

export function maskPII(value: string): string {
  if (value.includes("@")) return maskEmail(value);
  if (value.replace(/[^0-9]/g, "").length >= 7) return maskPhone(value);
  return value;
}

function maskContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string" && SECRET_KEY.test(k) && v.length > 0) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && PII_KEY.test(k) && v.length > 0) {
      out[k] = maskPII(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = maskContext(v as LogContext);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatLog(level: LogLevel, message: string, context?: LogContext) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? maskContext(context) : {}),
  });
}

export const logger = {
  debug(message: string, context?: LogContext) {
    if (shouldLog("debug")) {
      process.stdout.write(`${formatLog("debug", message, context)}\n`);
    }
  },
  info(message: string, context?: LogContext) {
    if (shouldLog("info")) {
      process.stdout.write(`${formatLog("info", message, context)}\n`);
    }
  },
  warn(message: string, context?: LogContext) {
    if (shouldLog("warn")) {
      process.stderr.write(`${formatLog("warn", message, context)}\n`);
    }
  },
  error(message: string, context?: LogContext) {
    if (shouldLog("error")) {
      process.stderr.write(`${formatLog("error", message, context)}\n`);
    }
  },
};
