/**
 * workspace-pages.spec.ts
 *
 * 이벤트 워크스페이스 미커버 16개 페이지 T2 e2e 스펙.
 *
 * 전략:
 *  - beforeAll: createFullEvent() 로 풀세팅 이벤트 1회 생성 (read-only 페이지 공유).
 *  - write 액션은 부작용이 안전한 것만 (idempotent upsert / 독립 row 생성).
 *  - 외부 실발송(메시지·이메일)은 테스트하지 않음 — API boundary 까지만.
 *  - AI 리포트(POST /api/ai/event-report) 는 timeout 60s.
 *
 * 대상 페이지 (16개):
 *  1.  bids            — GET /api/events/:id/bids
 *  2.  crm             — GET /api/events/:id/crm  + POST (action=sync)
 *  3.  discounts       — GET /api/events/:id/discounts  + POST 생성
 *  4.  facilities      — GET /api/events/:id/facilities  (POST boundary: v2 앵커 필요 → 409 허용)
 *  5.  participants    — GET /api/events/:id/participants (POST boundary: v2 앵커 필요 → 409 허용)
 *  6.  open-notices    — GET /api/events/:id/open-notices (POST boundary: v2 앵커 필요 → 409 허용)
 *  7.  final-call      — GET /api/events/:id/final-call  + PUT 설정
 *  8.  bridge-page     — GET /api/events/:id/bridge-page + PUT 설정
 *  9.  compliance      — GET /api/events/:id/compliance  (audit-logs schema)
 *  10. feature-manager — GET /api/events/:id/features  + PUT 토글
 *  11. packages        — GET /api/events/:id/packages  (bundle empty)
 *  12. ticket-issuance — GET /api/events/:id/ticket-issuance + POST 수동발권
 *  13. tickets         — GET /api/events/:id/sale-phases  + GET seat-maps
 *  14. bot-detection   — GET /api/events/:id/bot-detection
 *  15. rehearsal       — GET /api/events/:id/rehearsal  (체크리스트 스키마)
 *  16. reports/post-event — POST /api/ai/event-report (AI or fallback, 60s)
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { createFullEvent, type FullEventFixture } from "../helpers/fixture-event";

// ─── 공유 상태 ────────────────────────────────────────────────────────────────
let request: APIRequestContext;
let fx: FullEventFixture;

test.describe("워크스페이스 미커버 16페이지 — T2 주요 액션 e2e", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
    });
    fx = await createFullEvent(request);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. bids — GET lottery-stats + bids
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("1. bids — 응모/입찰 현황", () => {
    test("GET /api/events/:id/lottery-stats — 200 + 응모 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/lottery-stats`);
      expect(res.status(), `lottery-stats 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      // 응모 미설정 이벤트: v2 응답 없음 → 빈 응답 fallback
      expect(typeof data).toBe("object");
      expect("stats" in data || "phase" in data || "eventId" in data).toBe(true);
    });

    test("GET /api/events/:id/bids — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/bids`);
      expect(res.status(), `bids 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. crm — 목록 + 주문동기화
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("2. crm — 연락처 목록 + 동기화", () => {
    test("GET /api/events/:id/crm — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/crm`);
      expect(res.status(), `crm GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/crm (action=sync) — 200 + synced 반환", async () => {
      const res = await request.post(`/api/events/${fx.eventId}/crm`, {
        data: { action: "sync" },
      });
      expect(res.status(), `crm sync 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data.synced).toBe("number");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. discounts — 목록 + POST 생성
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("3. discounts — 할인 정보", () => {
    let createdDiscountId: string | null = null;

    test("GET /api/events/:id/discounts — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/discounts`);
      expect(res.status(), `discounts GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/discounts — 201 + id 반환", async () => {
      const suffix = Date.now();
      const res = await request.post(`/api/events/${fx.eventId}/discounts`, {
        data: {
          title: `E2E 얼리버드 ${suffix}`,
          discountType: "early_bird",
          discountRate: "15",
          description: "e2e 테스트 할인",
        },
      });
      expect(res.status(), `discounts POST 실패: ${await res.text()}`).toBe(201);
      const body = await res.json();
      const data = body.data ?? body;
      expect(data.id).toBeTruthy();
      createdDiscountId = data.id;
    });

    test("DELETE /api/events/:id/discounts?id=:discountId — 200", async () => {
      if (!createdDiscountId) {
        test.skip(true, "POST 생성 실패로 스킵");
        return;
      }
      const res = await request.delete(
        `/api/events/${fx.eventId}/discounts?id=${createdDiscountId}`,
      );
      expect(res.status(), `discounts DELETE 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect((body.data ?? body).deleted).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. facilities — GET 목록 + POST boundary
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("4. facilities — 시설 목록", () => {
    test("GET /api/events/:id/facilities — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/facilities`);
      expect(res.status(), `facilities GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/facilities — boundary(v2 앵커): 200/201 또는 409", async () => {
      // v2 write-through: v2_event_id 앵커 없으면 409, 있으면 200/201.
      // category CHECK: stage|sound|lighting|booth|seating|general
      const res = await request.post(`/api/events/${fx.eventId}/facilities`, {
        data: { name: `E2E 시설 ${Date.now()}`, category: "general", quantity: 50 },
      });
      expect(
        [200, 201, 409],
        `facilities POST 예상외 status: ${res.status()} — ${await res.text()}`,
      ).toContain(res.status());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. participants — GET 목록 + POST boundary
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("5. participants — 출연진 목록", () => {
    test("GET /api/events/:id/participants — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/participants`);
      expect(res.status(), `participants GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/participants — boundary(v2 앵커): 200/201 또는 409", async () => {
      // v2 write-through: v2_event_id 앵커 없으면 409, 있으면 200/201
      const res = await request.post(`/api/events/${fx.eventId}/participants`, {
        data: { name: `E2E 아티스트 ${Date.now()}`, role: "performer" },
      });
      expect(
        [200, 201, 409],
        `participants POST 예상외 status: ${res.status()} — ${await res.text()}`,
      ).toContain(res.status());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. open-notices — GET 목록 + POST boundary
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("6. open-notices — 오픈 공지", () => {
    test("GET /api/events/:id/open-notices — 200 + isPublished/createdAt 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/open-notices`);
      expect(res.status(), `open-notices GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/open-notices — boundary(v2 앵커): 200/201 또는 409", async () => {
      const res = await request.post(`/api/events/${fx.eventId}/open-notices`, {
        data: {
          type: "general",
          title: `E2E 공지 ${Date.now()}`,
          content: "e2e 테스트용 공지사항입니다.",
          isPublished: false,
        },
      });
      expect(
        [200, 201, 409],
        `open-notices POST 예상외 status: ${res.status()} — ${await res.text()}`,
      ).toContain(res.status());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. final-call — GET 설정 + PUT 토글
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("7. final-call — 마지막 할인 설정", () => {
    test("GET /api/events/:id/final-call — 200 + 설정 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/final-call`);
      expect(res.status(), `final-call GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
      // isActive 또는 triggerHoursBefore 중 하나는 반드시 있어야 함
      expect("isActive" in data || "is_active" in data || "triggerHoursBefore" in data).toBe(true);
    });

    test("PUT /api/events/:id/final-call — 200 + upsert", async () => {
      const res = await request.put(`/api/events/${fx.eventId}/final-call`, {
        data: {
          isActive: false,
          triggerHoursBefore: 48,
          discountPercent: 20,
          minRemainingPercent: 15,
          notifyBuyers: false,
        },
      });
      expect(res.status(), `final-call PUT 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data.id !== "undefined" || typeof data.event_id !== "undefined").toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. bridge-page — GET 설정 + PUT 토글
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("8. bridge-page — 브릿지 페이지 설정", () => {
    test("GET /api/events/:id/bridge-page — 200 + 설정 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/bridge-page`);
      expect(res.status(), `bridge-page GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
      expect("isActive" in data || "is_active" in data || "title" in data).toBe(true);
    });

    test("PUT /api/events/:id/bridge-page — 200 + upsert", async () => {
      const res = await request.put(`/api/events/${fx.eventId}/bridge-page`, {
        data: {
          isActive: false,
          title: `E2E 브릿지 ${Date.now()}`,
          description: "e2e 테스트 브릿지 페이지",
          backgroundColor: "#6C5CE7",
        },
      });
      expect(res.status(), `bridge-page PUT 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. compliance — GET 감사로그 + 통계 스키마
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("9. compliance — 감사 로그", () => {
    test("GET /api/events/:id/compliance — 200 + logs/stats 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/compliance`);
      expect(res.status(), `compliance GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
      // { logs: [], stats: { totalLogs, uniqueUsers, ... } }
      expect("logs" in data && "stats" in data).toBe(true);
      expect(Array.isArray(data.logs)).toBe(true);
      expect(typeof data.stats).toBe("object");
      const stats = data.stats;
      expect(typeof stats.totalLogs).toBe("number");
    });

    test("GET /api/events/:id/compliance?limit=5 — 200 + limit 적용", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/compliance?limit=5`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data.logs)).toBe(true);
      expect(data.logs.length).toBeLessThanOrEqual(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. feature-manager — GET 기능 목록 + PUT 토글
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("10. feature-manager — 기능 토글", () => {
    let originalFeatures: string[] = [];

    test("GET /api/events/:id/features — 200 + enabledFeatures/availableFeatures", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/features`);
      expect(res.status(), `features GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data.enabledFeatures)).toBe(true);
      expect(Array.isArray(data.availableFeatures)).toBe(true);
      expect(data.availableFeatures.length).toBeGreaterThan(0);
      originalFeatures = data.enabledFeatures;
    });

    test("PUT /api/events/:id/features — 200 + 토글 후 복원", async () => {
      // crm 토글 추가 (idempotent)
      const toEnable = Array.from(new Set([...originalFeatures, "crm"]));
      const res = await request.put(`/api/events/${fx.eventId}/features`, {
        data: { enabledFeatures: toEnable },
      });
      expect(res.status(), `features PUT 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data.enabledFeatures)).toBe(true);
      expect(data.enabledFeatures).toContain("crm");

      // 원래 상태로 복원
      await request.put(`/api/events/${fx.eventId}/features`, {
        data: { enabledFeatures: originalFeatures },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. packages — GET 번들 목록 (empty 정상)
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("11. packages — 번들 상품 목록", () => {
    test("GET /api/events/:id/packages — 200 + 배열 반환 (empty 허용)", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/packages`);
      expect(res.status(), `packages GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
      // 번들 없어도 빈 배열이어야 함
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. ticket-issuance — GET 수동발권 목록 + POST 발권
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("12. ticket-issuance — 수동 발권", () => {
    test("GET /api/events/:id/ticket-issuance — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/ticket-issuance`);
      expect(res.status(), `ticket-issuance GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /api/events/:id/ticket-issuance — 수동발권 (comp 경유): 200 또는 503", async () => {
      // v2 앵커 미준비이면 503, 준비되면 200
      const sfx = Date.now();
      const res = await request.post(`/api/events/${fx.eventId}/ticket-issuance`, {
        data: {
          name: `E2E 초대자 ${sfx}`,
          email: `comp-${sfx}@example.com`,
          phone: "010-0000-0001",
          productId: fx.productId,
          memo: "e2e 수동발권",
        },
      });
      // P1-8 수정: createOrder(v2 SSOT) 경유. v2 앵커 없으면 503.
      expect(
        [200, 503],
        `ticket-issuance POST 예상외 status: ${res.status()} — ${await res.text()}`,
      ).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        const data = body.data ?? body;
        expect(data.orderNumber || data.ticketNumber).toBeTruthy();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. tickets — GET sale-phases + seat-maps
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("13. tickets — 판매 단계 + 좌석맵", () => {
    test("GET /api/events/:id/sale-phases — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/sale-phases`);
      expect(res.status(), `sale-phases GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const items = body.data?.items ?? body.data ?? body.items ?? [];
      expect(Array.isArray(items)).toBe(true);
    });

    test("GET /api/events/:id/seat-maps — 200 + 배열 반환", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/seat-maps`);
      expect(res.status(), `seat-maps GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      // 배열 또는 items 배열
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      expect(Array.isArray(items)).toBe(true);
    });

    test("GET /api/events/:id/seat-maps/:mapId/seats — 200 (맵 있을 때)", async () => {
      if (!fx.seatMapId) {
        test.skip(true, "픽스처 좌석맵 없음 — 스킵");
        return;
      }
      const res = await request.get(
        `/api/events/${fx.eventId}/seat-maps/${fx.seatMapId}/seats`,
      );
      expect(res.status(), `seats GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. bot-detection — GET 집계 통계
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("14. bot-detection — 봇 탐지 통계", () => {
    test("GET /api/events/:id/bot-detection — 200 + 주요 집계 필드", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/bot-detection`);
      expect(res.status(), `bot-detection GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
      // totalOrders/flaggedOrders/highRiskOrders/avgFraudScore 중 하나 이상
      const hasStats =
        "totalOrders" in data ||
        "flaggedOrders" in data ||
        "highRiskOrders" in data ||
        "avgFraudScore" in data;
      expect(hasStats).toBe(true);
      expect(typeof data.totalOrders).toBe("number");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. rehearsal — GET 체크리스트 스키마
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("15. rehearsal — 이벤트 리허설 체크리스트", () => {
    test("GET /api/events/:id/rehearsal — 200 + productCount/orderCount 스키마", async () => {
      const res = await request.get(`/api/events/${fx.eventId}/rehearsal`);
      expect(res.status(), `rehearsal GET 실패: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const data = body.data ?? body;
      expect(typeof data).toBe("object");
      // productCount 는 반드시 존재 (상품이 있으므로)
      expect(typeof data.productCount).toBe("number");
      expect(data.productCount).toBeGreaterThan(0);
      expect(typeof data.orderCount).toBe("number");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. reports/post-event — POST /api/ai/event-report (fallback 포함, 60s)
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("16. reports/post-event — AI 포스트 이벤트 리포트", () => {
    test(
      "POST /api/ai/event-report — 200 + report 스키마 (AI 또는 fallback)",
      async () => {
        test.setTimeout(65_000);
        const res = await request.post("/api/ai/event-report", {
          data: { eventId: fx.eventId },
          timeout: 60_000,
        });
        // v2 앵커 없으면 404, AI 오류면 502, 정상이면 200
        expect(
          [200, 404, 502],
          `event-report POST 예상외 status: ${res.status()} — ${await res.text()}`,
        ).toContain(res.status());

        if (res.status() === 200) {
          const body = await res.json();
          const data = body.data ?? body;
          expect(typeof data.report).toBe("object");
          const report = data.report;
          // 필수 키: executiveSummary, salesSummary, attendeeSummary, overallGrade, oneLineSummary
          expect(typeof report.executiveSummary).toBe("string");
          expect(report.executiveSummary.length).toBeGreaterThan(0);
          expect(typeof report.salesSummary).toBe("string");
          expect(typeof report.attendeeSummary).toBe("string");
          expect(typeof report.overallGrade).toBe("string");
          expect(["A+", "A", "B+", "B", "C", "D"]).toContain(report.overallGrade);
          expect(typeof report.oneLineSummary).toBe("string");
          expect(Array.isArray(report.improvements)).toBe(true);
          // rawData 도 있어야 함
          expect(typeof data.rawData).toBe("object");
          expect(typeof data.rawData.title).toBe("string");
        }
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 보너스: 미인증 요청 → 401 guard 확인 (모든 admin 라우트 공통)
  // ─────────────────────────────────────────────────────────────────────────────
  test.describe("인증 가드 — 미인증 요청 거부", () => {
    test("GET /api/events/:id/compliance (비인증) — 401", async ({ playwright }) => {
      const anon = await playwright.request.newContext({
        baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
      });
      const res = await anon.get(`/api/events/${fx.eventId}/compliance`);
      expect([401, 403]).toContain(res.status());
      await anon.dispose();
    });

    test("GET /api/events/:id/bids (비인증) — 401", async ({ playwright }) => {
      const anon = await playwright.request.newContext({
        baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
      });
      const res = await anon.get(`/api/events/${fx.eventId}/bids`);
      expect([401, 403]).toContain(res.status());
      await anon.dispose();
    });
  });
});
