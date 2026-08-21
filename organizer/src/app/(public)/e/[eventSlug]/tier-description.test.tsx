// @vitest-environment node
/**
 * 🔴 공개 상세 **등급 카드**가 설명을 그리는가 (2026-08-11).
 *
 * 사기 전에 보여야 하는 자리 둘 중 하나다(다른 하나는 체크아웃 등급 선택).
 * 등급명이 「주중권 (목 1R ~ 금 2R)」이라 이틀로 읽히는데 실제로는 **하루만** 입장한다.
 *
 * ⚠️ 서버 컴포넌트지만 그냥 `async` 함수다 — 호출해 나온 트리에서 문자열을 찾는다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getPublicEventBySlug = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/server/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPublicEventBySlug: (...a: unknown[]) => getPublicEventBySlug(...a),
}));

import EventDetailPage from "./page";

const DAYPASS = "8월 20일 ~ 23일 기간 중 하루 입장하실 수 있습니다";

function product(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "주중권 (목 1R ~ 금 2R)",
    description: null,
    price: 13500,
    facePrice: null,
    stock: 100,
    taxIncluded: true,
    isOnSale: true,
    ...over,
  };
}

function event(products: Array<Record<string, unknown>>) {
  return {
    id: "ev-1",
    slug: "bc-hankyung-klpga2026",
    title: "BC카드·한경 제48회 KLPGA 챔피언십",
    status: "live",
    description: null,
    startsAt: "2026-08-20T01:00:00Z",
    endsAt: "2026-08-23T01:00:00Z",
    venueName: "포천힐스CC",
    venueAddress: "경기 포천시",
    heroImageUrl: null,
    imageVariants: null,
    galleryImages: [],
    detailImages: [],
    notices: [],
    schedules: [],
    products,
    organizerName: null,
    cancellationFeeTiers: [],
  };
}

/** 트리의 모든 문자열을 모은다(중복 방문 금지). */
function texts(node: unknown): string[] {
  const seen = new Set<object>();
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (typeof n !== "object" || seen.has(n as object)) return;
    seen.add(n as object);
    if (Array.isArray(n)) { n.forEach(walk); return; }
    Object.values((n as { props?: Record<string, unknown> }).props ?? {}).forEach(walk);
  };
  walk(node);
  return out;
}

async function render(products: Array<Record<string, unknown>>) {
  getPublicEventBySlug.mockResolvedValue(event(products));
  const tree = await EventDetailPage({
    params: Promise.resolve({ eventSlug: "bc-hankyung-klpga2026" }),
    // ⚠️ 페이지가 `searchParams` 도 구조분해한다(추천인 `?ref=`). 안 주면 렌더 전에 죽는다.
    searchParams: Promise.resolve({}),
  } as never);
  return texts(tree);
}

beforeEach(() => vi.clearAllMocks());

describe("🔴 등급 카드 설명", () => {
  it("🔴 설명이 있으면 상세 등급 카드에 뜬다", async () => {
    const t = await render([product({ description: DAYPASS })]);
    expect(t, "상세에 설명이 안 뜬다 — 사기 전에 못 본다").toContain(DAYPASS);
  });

  it("🔴 설명이 없는 등급에는 아무것도 안 뜬다", async () => {
    const t = await render([product({ description: null })]);
    expect(t).not.toContain(DAYPASS);
  });

  it("🔴 등급마다 자기 설명 — 하나를 전부에 박으면 안 된다", async () => {
    const t = await render([
      product({ description: DAYPASS }),
      product({ id: "p2", name: "주말권 (토 3R ~ 일 FR)", price: 22500, description: null }),
    ]);
    expect(t.filter((x) => x === DAYPASS), "설명 없는 등급에도 문구가 붙었다").toHaveLength(1);
  });

  it("등급명은 그대로 나온다 — 설명이 이름을 밀어내지 않는다", async () => {
    const t = await render([product({ description: DAYPASS })]);
    expect(t).toContain("주중권 (목 1R ~ 금 2R)");
  });
});
