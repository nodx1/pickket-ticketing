/**
 * 동시성 & 레이스 컨디션 테스트
 * - 재고 1개 상품에 동시 구매 → 1건만 성공
 * - 동일 주문 중복 완료 방어
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";
import { extractOwnerCookie } from "../helpers/checkout";

let request: APIRequestContext;
let eventId: string;

test.describe("동시성 & 레이스 컨디션", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ── 1. 재고 1개 상품에 동시 구매 ──────────────────────────────
  test("1. 재고 1개 상품 동시 구매 → 1건만 성공", async () => {
    test.setTimeout(120_000);

    // 재고 1개짜리 상품 생성
    const prodRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 재고1 ${Date.now()}`,
        type: "ticket",
        price: "10000",
        stock: "1",
        minPerOrder: "1",
        maxPerOrder: "1",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(prodRes.status()).toBe(201);
    const productId = (await prodRes.json()).data.id;

    // 3건 동시 체크아웃 시도
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        request.post("/api/checkout/initiate", {
          data: {
            eventId,
            buyerName: `동시구매자${i}`,
            buyerEmail: `race${i}@test.kr`,
            buyerPhone: `010-0000-000${i}`,
            items: [{ productId, quantity: 1 }],
          },
        }),
      ),
    );

    const statuses = await Promise.all(
      results.map(async (r) => {
        if (r.status === "fulfilled") return r.value.status();
        return 500;
      }),
    );

    const successCount = statuses.filter((s) => s === 201).length;
    const failCount = statuses.filter((s) => s >= 400).length;

    // 재고 1개이므로 최대 1건만 성공해야 함
    expect(successCount).toBeLessThanOrEqual(1);
    expect(successCount + failCount).toBe(3);

    // 상품 재고 확인 (0 이상이어야 함, 음수 불가)
    const stockRes = await request.get(`/api/events/${eventId}/products`);
    const products = (await stockRes.json()).data;
    const items = Array.isArray(products) ? products : products?.items ?? [];
    const product = items.find((p: { id: string }) => p.id === productId);
    expect(Number(product.stock)).toBeGreaterThanOrEqual(0);
  });

  // ── 2. 동일 주문 중복 완료 방어 ──────────────────────────────
  test("2. 동일 주문 중복 complete 호출 → 멱등 응답", async () => {
    test.setTimeout(120_000);

    // 상품 생성
    const prodRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 중복완료 ${Date.now()}`,
        type: "ticket",
        price: "10000",
        stock: "10",
        minPerOrder: "1",
        maxPerOrder: "5",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    const productId = (await prodRes.json()).data.id;

    // 주문 생성
    const initRes = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        buyerName: "중복완료테스트",
        buyerEmail: "dupe-complete@test.kr",
        buyerPhone: "010-0000-9999",
        items: [{ productId, quantity: 1 }],
      },
    });
    const initBody = await initRes.json();
    const orderId = initBody.data.orderId;
    const ownerCookie = extractOwnerCookie(initRes);
    const cookieHeader: Record<string, string> = ownerCookie ? { Cookie: `pickket_last_order=${ownerCookie}` } : {};

    // 동시에 2번 complete 호출 (같은 쿠키로 — 소유권 동일)
    const [res1, res2] = await Promise.all([
      request.post("/api/checkout/complete", { data: { orderId, paymentMethod: "offline" }, headers: cookieHeader }),
      request.post("/api/checkout/complete", { data: { orderId, paymentMethod: "offline" }, headers: cookieHeader }),
    ]);

    // 최소 1건 200 (성공 또는 이미 완료)
    const statuses = [res1.status(), res2.status()];
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    // 500 에러는 없어야 함
    expect(statuses.every((s) => s < 500)).toBeTruthy();
  });

  // ── 3. 존재하지 않는 주문 complete ────────────────────────────
  test("3. 존재하지 않는 주문 complete → 404", async () => {
    // 소유권 쿠키 값은 요청 orderId 와 일치해야 소유권 통과 → DB 조회에서 404.
    const fakeOrderId = "00000000-0000-0000-0000-000000000000";
    const res = await request.post("/api/checkout/complete", {
      data: {
        orderId: fakeOrderId,
        paymentMethod: "offline",
      },
      headers: { Cookie: `pickket_last_order=${fakeOrderId}` },
    });
    expect(res.status()).toBe(404);
  });

  // ── 4. 잘못된 UUID 형식 ──────────────────────────────────────
  test("4. 잘못된 UUID 형식 → 400", async () => {
    const res = await request.post("/api/checkout/complete", {
      data: {
        orderId: "not-a-uuid",
        paymentMethod: "offline",
      },
    });
    expect(res.status()).toBe(400);
  });

  // ── 5. 존재하지 않는 상품으로 체크아웃 ────────────────────────
  test("5. 존재하지 않는 상품 체크아웃 → 실패", async () => {
    const res = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        buyerName: "유령상품",
        buyerEmail: "ghost@test.kr",
        buyerPhone: "010-0000-0000",
        items: [{ productId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  // ── 6. 최대 수량 초과 주문 ────────────────────────────────────
  test("6. maxPerOrder 초과 주문 → 실패", async () => {
    const prodRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 수량제한 ${Date.now()}`,
        type: "ticket",
        price: "10000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "2",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    const productId = (await prodRes.json()).data.id;

    const res = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        buyerName: "수량초과",
        buyerEmail: "over@test.kr",
        buyerPhone: "010-0000-0000",
        items: [{ productId, quantity: 5 }],
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
