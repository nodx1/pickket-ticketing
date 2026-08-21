import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.server 는 server-only 가드가 있어 vitest node 환경에서 직접 import 불가 → 시크릿 고정 스텁.
vi.mock("@/lib/env.server", () => ({
  getRuntimeSecret: (_key: string, fallback: string) => fallback,
}));

import {
  clampToleranceWindows,
  generateDynamicQRPayload,
  generateDynamicQRPayloads,
  verifyDynamicQRPayload,
  MAX_PREFETCH_WINDOWS,
  MAX_TOLERANCE_WINDOWS,
} from "./dynamic-qr";

// §13 QR 창 확대 킬스위치 — tolerance 파라미터로 수락 시간창 확대.
const WINDOW_MS = 30 * 1000;

describe("clampToleranceWindows", () => {
  // 🔴 기본 5창(±150초 = 총 5분) — 대표 결정(2026-07-29, 야외 골프장 기준).
  //    낮추면 현장 입장이 막히고 올리면 캡처 재사용 창이 넓어진다.
  it("기본/무효 입력은 5창(=5분)으로 정규화", () => {
    for (const v of [undefined, null, NaN, 0, -5, 1, 4]) {
      expect(clampToleranceWindows(v as number)).toBe(5);
    }
  });

  it("상한(MAX)으로 clamp — 무제한 캡처방지 무력화 금지", () => {
    expect(clampToleranceWindows(999)).toBe(MAX_TOLERANCE_WINDOWS);
    expect(clampToleranceWindows(8)).toBe(8);
    expect(clampToleranceWindows(8.9)).toBe(8);
  });
});

describe("verifyDynamicQRPayload tolerance 창", () => {
  const now = 1_800_000_000_000; // 고정 기준 시각

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("🔴 5분 안(4창=120초 전) QR 은 기본값으로 수락 — 게이트 줄서기 대비", () => {
    vi.setSystemTime(now - 4 * WINDOW_MS);
    const payload = generateDynamicQRPayload("TCKT-1");
    vi.setSystemTime(now);
    expect(verifyDynamicQRPayload(payload).valid).toBe(true);
    expect(verifyDynamicQRPayload(payload).ticketId).toBe("TCKT-1");
  });

  it("🔴 5분을 넘긴(6창=180초 전) QR 은 기본값으로 거부 — 캡처 무한재사용 차단", () => {
    vi.setSystemTime(now - 6 * WINDOW_MS);
    const payload = generateDynamicQRPayload("TCKT-1");
    vi.setSystemTime(now);
    expect(verifyDynamicQRPayload(payload).valid).toBe(false);
  });

  it("킬스위치로 확대하면 그보다 오래된 QR 도 수락", () => {
    vi.setSystemTime(now - 8 * WINDOW_MS);
    const payload = generateDynamicQRPayload("TCKT-1");
    vi.setSystemTime(now);
    expect(verifyDynamicQRPayload(payload).valid).toBe(false);
    expect(verifyDynamicQRPayload(payload, 8).valid).toBe(true);
  });

  it("확대해도 상한(MAX+1창) 밖 QR 은 거부", () => {
    vi.setSystemTime(now - (MAX_TOLERANCE_WINDOWS + 1) * WINDOW_MS);
    const payload = generateDynamicQRPayload("TCKT-1");
    vi.setSystemTime(now);
    // 999 요청해도 MAX 로 clamp → MAX+1창 밖은 거부.
    expect(verifyDynamicQRPayload(payload, 999).valid).toBe(false);
  });

  it("변조 HMAC 은 tolerance 와 무관하게 거부", () => {
    const payload = generateDynamicQRPayload("TCKT-1").replace(/:[0-9a-f]+$/, ":deadbeefdeadbeef");
    expect(verifyDynamicQRPayload(payload, MAX_TOLERANCE_WINDOWS).valid).toBe(false);
  });

  it("현재창 QR 은 기본 tolerance 로도 수락(하위호환)", () => {
    const payload = generateDynamicQRPayload("TCKT-1");
    expect(verifyDynamicQRPayload(payload).valid).toBe(true);
  });
});

/**
 * 🔴 오프라인 대비 선발급 — 골프장에서 LTE 가 끊겨도 QR 이 살아 있어야 한다.
 * 종전엔 30초마다 서버 호출이 필요했고, 그 호출이 실패하면 QR 이 죽어 입장이 막혔다.
 */
describe("generateDynamicQRPayloads — 선발급", () => {
  const now = 1_800_000_000_000;

  it("요청한 개수만큼 **연속된 창**의 코드를 준다", () => {
    const list = generateDynamicQRPayloads("TCKT-1", 5, now);
    expect(list).toHaveLength(5);
    const base = list[0]!.window;
    expect(list.map((x) => x.window)).toEqual([base, base + 1, base + 2, base + 3, base + 4]);
  });

  it("🔴 각 코드는 **그 창의 시각에** 검증을 통과한다", () => {
    const list = generateDynamicQRPayloads("TCKT-1", 6, now);
    vi.useFakeTimers();
    try {
      // 3창 뒤(90초 후)로 시계를 옮겨도 그 창의 코드가 유효하다.
      vi.setSystemTime(now + 3 * WINDOW_MS);
      const r = verifyDynamicQRPayload(list[3]!.payload);
      expect(r.valid).toBe(true);
      expect(r.ticketId).toBe("TCKT-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("🔴 상한을 넘겨 요청해도 잘린다 — 한 응답이 사실상 영구 코드가 되면 안 된다", () => {
    expect(generateDynamicQRPayloads("TCKT-1", 9999, now)).toHaveLength(MAX_PREFETCH_WINDOWS);
  });

  it("0·음수·NaN 은 최소 1개", () => {
    for (const n of [0, -3, NaN]) {
      expect(generateDynamicQRPayloads("TCKT-1", n, now)).toHaveLength(1);
    }
  });

  it("단건 생성과 같은 알고리즘이다(스캐너 계약 불변)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      expect(generateDynamicQRPayloads("TCKT-1", 1, now)[0]!.payload).toBe(
        generateDynamicQRPayload("TCKT-1"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
