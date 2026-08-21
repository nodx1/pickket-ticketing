import type { APIRequestContext } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * Admin E2E 테스트 API 헬퍼
 *
 * 모든 함수는 Playwright의 APIRequestContext를 사용하여
 * 백엔드 API를 직접 호출합니다 (브라우저 미사용).
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_URL || "http://localhost:8021/api/v1";

/* ── Auth ─────────────────────────────────────────────────────────── */

/** Admin 로그인 via API — access_token을 반환 */
export async function adminLogin(
  request: APIRequestContext,
  email?: string,
  password?: string,
): Promise<string> {
  const resp = await request.post(`${API_BASE}/auth/login`, {
    data: {
      email: email || process.env.E2E_ADMIN_EMAIL,
      password: password || process.env.E2E_ADMIN_PASSWORD,
    },
  });

  if (!resp.ok()) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Admin 로그인 실패 [${resp.status()}]: ${body}`);
  }

  const json = (await resp.json()) as {
    access_token: string;
    user: { is_admin: boolean };
  };

  if (!json.user?.is_admin) {
    throw new Error("로그인된 계정이 관리자(is_admin)가 아닙니다.");
  }

  return json.access_token;
}

/* ── HTTP helpers ─────────────────────────────────────────────────── */

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

/** Raw 요청 — status + body 반환 (에러를 던지지 않음) */
export async function adminRequest(
  request: APIRequestContext,
  method: string,
  path: string,
  token: string,
  data?: unknown,
): Promise<ApiResponse> {
  const url = `${API_BASE}${path}`;
  const options = {
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined ? { data } : {}),
  };

  const resp = await request.fetch(url, { method, ...options });
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), body };
}

/** GET with admin Bearer token */
export async function adminGet(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<unknown> {
  const resp = await request.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok()) {
    throw new Error(`GET ${path} 실패 [${resp.status()}]`);
  }
  return resp.json();
}

/** POST with admin Bearer token */
export async function adminPost(
  request: APIRequestContext,
  path: string,
  token: string,
  data?: unknown,
): Promise<ApiResponse> {
  const resp = await request.post(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined ? { data } : {}),
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), body };
}

/** PATCH with admin Bearer token */
export async function adminPatch(
  request: APIRequestContext,
  path: string,
  token: string,
  data?: unknown,
): Promise<ApiResponse> {
  const resp = await request.patch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined ? { data } : {}),
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), body };
}

/** DELETE with admin Bearer token */
export async function adminDelete(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<ApiResponse> {
  const resp = await request.delete(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), body };
}

/* ── Data finders ─────────────────────────────────────────────────── */

interface AdminEvent {
  id: string;
  title: string;
  status: string;
  [key: string]: unknown;
}

interface AdminOrder {
  id: string;
  order_number?: string;
  status: string;
  [key: string]: unknown;
}

/**
 * 관리 가능한 이벤트 1건 조회.
 * status를 지정하면 해당 상태의 이벤트만 찾고, 미지정 시 첫 번째 이벤트를 반환.
 */
export async function findEventByStatus(
  request: APIRequestContext,
  token: string,
  status?: string,
): Promise<AdminEvent | null> {
  const query = status ? `?status=${status}&limit=20` : "?limit=20";
  const { status: httpStatus, body } = await adminRequest(
    request,
    "GET",
    `/admin/events${query}`,
    token,
  );

  if (httpStatus !== 200 || !body) return null;

  const events = (body as { events?: AdminEvent[] }).events ?? [];
  return events[0] ?? null;
}

/**
 * 관리 가능한 주문 1건 조회.
 * status를 지정하면 해당 상태만 필터, 미지정 시 첫 번째 주문을 반환.
 */
export async function findOrder(
  request: APIRequestContext,
  token: string,
  status?: string,
): Promise<AdminOrder | null> {
  const query = status ? `?status=${status}&limit=20` : "?limit=20";
  const { status: httpStatus, body } = await adminRequest(
    request,
    "GET",
    `/admin/orders${query}`,
    token,
  );

  if (httpStatus !== 200 || !body) return null;

  const orders = (body as { orders?: AdminOrder[] }).orders ?? [];
  return orders[0] ?? null;
}
