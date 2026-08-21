/**
 * 통합테스트 공용 하네스 (T8) — **실 PostgreSQL + 실 HTTP**.
 *
 * 설계 원칙 두 가지. 둘 다 기존 테스트층이 놓친 것을 정면으로 겨냥한다.
 *
 *  1. DB 를 모킹하지 않는다. `vi.mock("@/lib/db/pool")` 은 SQL 을 한 줄도 실행하지 않으므로
 *     NOT NULL·CHECK·FK·트랜잭션 롤백 같은 **DB 가 강제하는 계약**을 검증할 수 없다.
 *     실제로 `next_retry_at NOT NULL` 위반(23502)이 그 공백을 통과해 prod 까지 갔다.
 *
 *  2. v2 도 모듈 모킹이 아니라 **진짜 HTTP 서버**로 세운다. 그래야 commerce-client 의
 *     서명·재시도·상태코드→예외 매핑이 실제로 실행된다. `vi.mock("@/lib/v2/commerce-client")`
 *     로는 "4xx 는 즉시 throw, 5xx 는 재시도, 네트워크 오류는 status 0" 같은 계약이 통째로 빠진다.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getPool } from "@/lib/db/pool";

// ── v2 스텁 서버 ────────────────────────────────────────────────────────────────

export interface StubRoute {
  /** "POST /api/v1/internal/orders/:id/refund" 형태. :param 은 와일드카드. */
  method: string;
  pathPattern: RegExp;
  /** 응답 상태코드. 4xx/5xx 면 commerce-client 가 V2CommerceError 를 던진다. */
  status: number;
  /** ok 봉투에 실릴 data. status 가 2xx 일 때만 사용. */
  data?: unknown;
  /** 에러 봉투 body(문자열). status 가 4xx/5xx 일 때 사용. */
  errorBody?: string;
}

export interface V2Stub {
  baseUrl: string;
  /**
   * 호출 기록 — "provider 를 부르지 않았는가" 같은 부정형 단언에 쓴다.
   * 🔴 headers 도 기록한다. 없으면 HMAC 서명과 Idempotency-Key 를 검증할 수 없다
   *    (재검수 실증: 서명 로직을 완전히 파괴해도 17/17 그린이었다).
   */
  calls: Array<{ method: string; path: string; body: string; headers: Record<string, string> }>;
  routes: StubRoute[];
  close: () => Promise<void>;
}

export async function startV2Stub(routes: StubRoute[] = []): Promise<V2Stub> {
  const calls: V2Stub["calls"] = [];
  const stub: Partial<V2Stub> = { calls, routes };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const path = req.url ?? "";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v ?? "");
      calls.push({ method: req.method ?? "", path, body, headers });
      const route = (stub.routes ?? []).find(
        (r) => r.method === req.method && r.pathPattern.test(path),
      );
      if (!route) {
        // 정의되지 않은 호출은 **명시적으로 실패**시킨다. 조용히 200 을 주면
        // "호출되지 않아야 할 경로가 호출된" 결함을 테스트가 덮어버린다.
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "STUB_UNDEFINED", message: `스텁 미정의: ${req.method} ${path}` } }));
        return;
      }
      if (route.status >= 200 && route.status < 300) {
        res.writeHead(route.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: route.data ?? {} }));
        return;
      }
      res.writeHead(route.status, { "Content-Type": "application/json" });
      res.end(route.errorBody ?? JSON.stringify({ ok: false, error: { code: "STUB_ERROR", message: "스텁 오류 응답" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stub.baseUrl = `http://127.0.0.1:${port}`;
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stub as V2Stub;
}

/** commerce-client 가 이 스텁을 보도록 env 를 건다. 원복 함수를 돌려준다. */
export function useV2Stub(stub: V2Stub): () => void {
  const prevBase = process.env.V2_INTERNAL_BASE_URL;
  const prevSecret = process.env.GO_WEBHOOK_SECRET;
  process.env.V2_INTERNAL_BASE_URL = stub.baseUrl;
  process.env.GO_WEBHOOK_SECRET = prevSecret ?? "itest-secret";
  return () => {
    if (prevBase === undefined) delete process.env.V2_INTERNAL_BASE_URL;
    else process.env.V2_INTERNAL_BASE_URL = prevBase;
    if (prevSecret === undefined) delete process.env.GO_WEBHOOK_SECRET;
    else process.env.GO_WEBHOOK_SECRET = prevSecret;
  };
}

// ── DB 시드 ────────────────────────────────────────────────────────────────────

export interface SeededOrder {
  accountId: string;
  eventId: string;
  orderId: string;
  v2OrderId: string;
}

/** 테스트가 건드리는 테이블만 비운다(스키마는 유지 — 마이그레이션 재적용 비용 회피). */
export async function resetTables(): Promise<void> {
  const pool = getPool();
  await pool.query(
    // audit_outbox 는 orders 로의 FK 가 없어 CASCADE 가 닿지 않는다 — 명시적으로 비운다
    // (재검수 실증: 관리자 조작마다 적재돼 테스트 간 누적, dedup UNIQUE 회귀를 가릴 수 있었다).
    `TRUNCATE payment_confirm_outbox, payment_compensation_actions, audit_outbox,
              orders, events, accounts RESTART IDENTITY CASCADE`,
  );
}

export async function seedOrder(opts: {
  orderStatus?: string;
  totalAmount?: number;
  v2OrderId?: string;
} = {}): Promise<SeededOrder> {
  const pool = getPool();
  const suffix = Math.floor(Math.random() * 1e9).toString(36);
  const acc = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, slug, contact_email) VALUES ($1,$2,$3) RETURNING id`,
    [`itest-${suffix}`, `itest-${suffix}`, `itest-${suffix}@pickket.kr`],
  );
  const accountId = acc.rows[0].id;
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (account_id, title, slug) VALUES ($1,$2,$3) RETURNING id`,
    [accountId, `itest 행사 ${suffix}`, `itest-event-${suffix}`],
  );
  const eventId = ev.rows[0].id;
  const v2OrderId = opts.v2OrderId ?? crypto.randomUUID();
  const ord = await pool.query<{ id: string }>(
    `INSERT INTO orders (account_id, event_id, order_number, buyer_name, buyer_email,
                         status, total_amount, v2_order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [accountId, eventId, `ITEST-${suffix}`, "홍길동", `buyer-${suffix}@pickket.kr`,
      opts.orderStatus ?? "completed", opts.totalAmount ?? 15000, v2OrderId],
  );
  return { accountId, eventId, orderId: ord.rows[0].id, v2OrderId };
}

export async function readOrder(orderId: string) {
  const { rows } = await getPool().query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  return rows[0];
}

export async function readCompensation(actionId: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM payment_compensation_actions WHERE id = $1`, [actionId]);
  return rows[0];
}

export async function readOutbox(orderId: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM payment_confirm_outbox WHERE order_id = $1`, [orderId]);
  return rows[0];
}

/**
 * 스텁이 받은 요청의 HMAC 서명을 **실제로 검증**한다.
 *
 * 스텁 서버가 서명을 보지 않으므로, 서명 로직이 완전히 망가져도 테스트는 통과한다
 * (재검수에서 실증됨). v2 가 `INTERNAL_COMMERCE_REQUIRE_HMAC` 를 켜는 순간 전 커머스 호출이
 * 401 이 되는데 하네스는 계속 초록일 수 있다. 그 공백을 메우기 위한 검증기.
 *
 * 계약: `X-Pickket-Signature = HMAC-SHA256(GO_WEBHOOK_SECRET, \`${timestamp}.${rawBody}\`)`
 */
export function verifyStubSignature(
  call: { body: string; headers: Record<string, string> },
  secret = process.env.GO_WEBHOOK_SECRET ?? "",
): { ok: boolean; reason?: string } {
  const signature = call.headers["x-pickket-signature"];
  const timestamp = call.headers["x-pickket-timestamp"];
  if (!signature) return { ok: false, reason: "X-Pickket-Signature 헤더 없음" };
  if (!timestamp) return { ok: false, reason: "X-Pickket-Timestamp 헤더 없음" };
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${call.body}`)
    .digest("hex");
  return signature === expected
    ? { ok: true }
    : { ok: false, reason: `서명 불일치 (기대 ${expected.slice(0, 12)}… / 수신 ${signature.slice(0, 12)}…)` };
}
