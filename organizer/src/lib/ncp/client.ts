/**
 * NCP(Naver Cloud Platform) API Gateway 공통 클라이언트.
 * x-ncp-apigw-signature-v2 (HMAC-SHA256) 서명 + JSON 요청.
 * Cloud Outbound Mailer(이메일) · SENS(SMS/알림톡) 공용.
 *
 * 공통 env: NCP_ACCESS_KEY, NCP_SECRET_KEY (IAM 서브계정 인증키)
 * 서명 규격(공식): StringToSign = METHOD + " " + URI(path+query) + "\n" + timestamp(ms) + "\n" + accessKey
 *   → base64( HMAC-SHA256(secretKey, StringToSign) ). timestamp/accessKey 는 헤더 값과 반드시 동일해야 함.
 */
import crypto from "node:crypto";

// env.server(server-only) 를 import 하지 않는다 — 이 클라이언트는 Next 서버 라우트뿐 아니라
// 독립 tsx 워커(scripts/workers/*)에서도 쓰이는데, server-only 는 Next 밖에서 resolve 되지 않는다.
function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export interface NcpCreds {
  accessKey: string;
  secretKey: string;
}

export interface NcpRequestOptions {
  /** 논리 발송의 안정적인 key. 없으면 request fingerprint를 사용한다. */
  idempotencyKey?: string;
  /** 호출자가 상태 원장에 연결할 logical message/recipient 식별자. */
  logicalMessageId?: string;
  recipientId?: string;
}

export class NcpAmbiguousError extends Error {
  readonly ambiguous = true;
  constructor(
    message: string,
    readonly idempotencyKey: string,
    readonly requestFingerprint: string,
    readonly httpStatus: number | null = null,
    readonly timeoutStage: "transport" | "provider_response" = "transport",
  ) {
    super(message);
    this.name = "NcpAmbiguousError";
  }
}

/** NCP 공통 인증키. 미설정이면 null (호출측이 dev 시뮬 / prod throw 판단). */
export function getNcpCreds(): NcpCreds | null {
  const accessKey = getEnv("NCP_ACCESS_KEY");
  const secretKey = getEnv("NCP_SECRET_KEY");
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey };
}

/** x-ncp-apigw-signature-v2 서명 생성. uri 는 서명 대상 경로(쿼리 포함, host 제외). */
export function makeNcpSignature(
  method: string,
  uri: string,
  timestamp: string,
  creds: NcpCreds,
): string {
  const message = `${method} ${uri}\n${timestamp}\n${creds.accessKey}`;
  return crypto.createHmac("sha256", creds.secretKey).update(message).digest("base64");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 재시도 가능한 오류인가 — 429(과금제한)·5xx(일시장애). 4xx(서명·검증)는 재시도 무의미. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * NCP API Gateway 로 서명된 JSON 요청. host(도메인)와 uri(서명 대상 경로)를 분리 전달.
 * 2xx 면 파싱된 JSON 반환, 그 외엔 상태코드+본문으로 throw.
 * 429/5xx/네트워크 오류는 지수 백오프로 최대 3회 재시도(서명 timestamp 는 매 시도 갱신).
 */
export async function ncpJsonRequest<T = unknown>(
  host: string,
  method: "POST" | "GET",
  uri: string,
  body: unknown,
  creds: NcpCreds,
  options: NcpRequestOptions = {},
): Promise<T> {
  const MAX_ATTEMPTS = 3;
  const serializedBody = body === undefined ? "" : JSON.stringify(body);
  const requestFingerprint = crypto
    .createHash("sha256")
    .update(`${method}\n${uri}\n${serializedBody}`)
    .digest("hex");
  const idempotencyKey = options.idempotencyKey ?? `ncp:${requestFingerprint}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 서명은 timestamp 를 포함 → 재시도마다 새로 생성(만료 방지).
    const timestamp = Date.now().toString();
    const signature = makeNcpSignature(method, uri, timestamp, creds);

    try {
      const res = await fetch(`${host}${uri}`, {
        method,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-ncp-apigw-timestamp": timestamp,
          "x-ncp-iam-access-key": creds.accessKey,
          "x-ncp-apigw-signature-v2": signature,
          // NCP SENS/Mailer currently do not document this header, but sending the
          // stable key is harmless and enables provider-side dedupe if/when enabled.
          "X-Idempotency-Key": idempotencyKey,
        },
        body: body === undefined ? undefined : serializedBody,
          signal: AbortSignal.timeout(Number.isFinite(Number(process.env.NCP_API_TIMEOUT_MS))
            ? Math.max(1_000, Number(process.env.NCP_API_TIMEOUT_MS))
            : 10_000),
      });

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 429 && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`NCP API ${res.status}: ${text.slice(0, 300)}`);
          await sleep(300 * 2 ** (attempt - 1)); // 300 → 600 → 1200ms
          continue;
        }
        if (res.status >= 500 && res.status < 600 && method === "POST") {
          throw new NcpAmbiguousError(
            `NCP API ${res.status}: provider 처리 여부 불명확`,
            idempotencyKey,
            requestFingerprint,
            res.status,
            "provider_response",
          );
        }
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`NCP API ${res.status}: ${text.slice(0, 300)}`);
          await sleep(300 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`NCP API ${res.status}: ${text.slice(0, 300)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      // HTTP 오류(위에서 throw)면 재시도하지 않고 전파. 네트워크/타임아웃만 재시도.
      if (err instanceof NcpAmbiguousError) throw err;
      const isHttpError = err instanceof Error && err.message.startsWith("NCP API ");
      lastErr = err;
      if (method === "POST" && !isHttpError) {
        throw new NcpAmbiguousError(
          `NCP ${method} 요청 응답 불명확: ${err instanceof Error ? err.message : String(err)}`,
          idempotencyKey,
          requestFingerprint,
          null,
          "transport",
        );
      }
      if (isHttpError || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(300 * 2 ** (attempt - 1));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("NCP API 요청 실패");
}

// Optional fault-proxy overrides are intentionally explicit and useful only for
// sandbox/rehearsal runs. Production keeps the official hosts by default.
export const NCP_MAILER_HOST = getEnv("NCP_MAILER_HOST") ?? "https://mail.apigw.ntruss.com";
export const NCP_SENS_HOST = getEnv("NCP_SENS_HOST") ?? "https://sens.apigw.ntruss.com";
