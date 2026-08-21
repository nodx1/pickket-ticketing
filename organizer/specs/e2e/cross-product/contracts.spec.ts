/**
 * 🔌 Tier0 계약 테스트 — go↔v2 응답 스키마 핀.
 *
 * go 가 의존하는 v2 internal 응답의 **키/형태를 고정**한다. v2 가 응답키를 바꾸면
 * (예: discount_code_id→code_id) 이 테스트가 즉시 깨져 go 가 프로덕션에서 502 나기 전에 잡는다.
 * (2026-06 실증: promo discount_code_id 키 불일치로 프로모 항상 502였음 — 사일로 테스트가 못 잡음.)
 *
 * 가장 싼 seam 가드 — CI 필수 게이트 권장.
 */
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { v2Call } from "../helpers/v2";

const ORG = "f5e619f0-e7f7-47cf-808c-4beaee65fe84"; // demo go account_id (provision 시 organizer_profile 등록됨)

test.describe("🔌 go↔v2 계약 (응답키 핀)", () => {
  let eventId: string;
  let tierId: string;

  test("createEvent: status=approved 수용 + {event_id, status} 반환", async () => {
    const r = await v2Call<{ event_id: string; status: string }>("POST", "/api/v1/internal/events", {
      organizer_ref: { go_account_id: ORG },
      external_ref: crypto.randomUUID(),
      title: "contract",
      venue: "h",
      category: "concert",
      event_date: new Date(Date.now() + 7 * 864e5).toISOString(),
      sale_window: { opens_at: new Date(Date.now() - 3600e3).toISOString(), closes_at: new Date(Date.now() + 7 * 864e5).toISOString() },
      sale_channels: ["self"],
      status: "approved", // 발행 계약: go live→approved (v2가 'live' 거부하면 발행 깨짐)
    });
    expect(r.status, `createEvent ${r.raw}`).toBe(200);
    expect(typeof r.data?.event_id).toBe("string");
    eventId = r.data!.event_id;
  });

  test("upsertTiers: 응답 tiers[].tier_id", async () => {
    const r = await v2Call<{ tiers: Array<{ tier_id: string; external_ref?: string }> }>(
      "POST",
      `/api/v1/internal/events/${eventId}/tiers`,
      { tiers: [{ external_ref: crypto.randomUUID(), name: "C", price: 30000, capacity: 4, sale_mode: "fixed_fcfs" }] },
    );
    expect(r.status).toBe(200);
    expect(typeof r.data?.tiers?.[0]?.tier_id, "tier_id 키 드리프트").toBe("string");
    tierId = r.data!.tiers[0].tier_id;
  });

  test("⚠️ discount-codes: 응답 codes[].discount_code_id (code_id 아님)", async () => {
    // 실증 발견 P1: go 가 code_id 를 읽는데 v2 는 discount_code_id 반환 → undefined → 항상 502.
    const r = await v2Call<{ codes: Array<{ code: string; discount_code_id: string }> }>(
      "POST",
      `/api/v1/internal/events/${eventId}/discount-codes`,
      { codes: [{ code: `CT${Date.now() % 100000}`, discount_type: "percentage", rate: 10 }] },
    );
    expect(r.status).toBe(200);
    expect(
      typeof r.data?.codes?.[0]?.discount_code_id,
      "discount_code_id 키 드리프트 — go promo write-through 가 502 난다",
    ).toBe("string");
  });

  test("upsertSeats: 응답 seats[].{seat_id, external_ref, status}", async () => {
    const r = await v2Call<{ seats: Array<{ seat_id: string; external_ref?: string | null }> }>(
      "POST",
      `/api/v1/internal/events/${eventId}/seats`,
      { seats: [{ external_ref: crypto.randomUUID(), section: "A", row_number: 1, seat_number: 1, tier_id: tierId }] },
    );
    expect(r.status).toBe(200);
    expect(typeof r.data?.seats?.[0]?.seat_id).toBe("string");
    // external_ref(=go seat id) 는 go 공개 좌석 read 양면머지(G4)의 키 — 반드시 존재
    expect(r.data?.seats?.[0]?.external_ref ?? null).not.toBeUndefined();
  });

  test("listSeats: 응답 {seats[].external_ref, status, status_counts}", async () => {
    // G4 가드: go 공개 좌석 read 가 external_ref+status 로 v2 SoT 머지함 → 키 보장 필수.
    const r = await v2Call<{ seats: Array<{ external_ref: string | null; status: string }>; status_counts: Record<string, number> }>(
      "GET",
      `/api/v1/internal/events/${eventId}/seats?limit=10`,
    );
    expect(r.status).toBe(200);
    const s = r.data?.seats?.[0];
    expect(s?.external_ref ?? null, "external_ref 키 — 좌석 양면머지 깨짐").not.toBeUndefined();
    expect(typeof s?.status, "status 키 — SoT status 머지 깨짐").toBe("string");
  });
});
