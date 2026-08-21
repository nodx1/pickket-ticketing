// @vitest-environment node
/**
 * 🔴 공개 상세 **프로그램·일정 탭**이 일정 안내 이미지를 그리는가 (2026-08-19)
 *
 * 대회 1라운드 조편성표를 랜딩에 올리기 위한 자리다. 주최자가 올려도 여기서 안 그리면
 * **아무도 못 본다** — 그게 이 기능의 유일한 목적이다.
 *
 * ## 🔴 문자열 존재 검사로 하지 않는다
 * "URL 이 트리 어딘가에 있다" 는 아무것도 증명하지 않는다(링크에만 있어도 통과한다).
 * **관계**를 본다: `<img>` 의 `src` 가 그 일정의 `imageUrl` 이고, `alt` 가 그 일정의
 * 제목을 담고 있는가. 그리고 이미지가 **없는 일정에는 안 붙는가**.
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

const IMG = "https://cdn.pickket.kr/uploads/general/round1.png";

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    title: "1라운드 조편성",
    description: "1번 홀 출발",
    startsAt: "2026-08-20T01:00:00Z",
    endsAt: null,
    venueName: "포천힐스CC",
    sortOrder: 0,
    imageUrl: null,
    ...over,
  };
}

function event(schedules: Array<Record<string, unknown>>) {
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
    schedules,
    products: [],
    organizerName: null,
    cancellationFeeTiers: [],
  };
}

/**
 * 트리에서 특정 태그의 엘리먼트를 전부 모은다(props 포함, 중복 방문 금지).
 *
 * ⚠️ **엘리먼트가 아닌 평범한 객체도 따라 들어간다.** 이 페이지는 탭 내용을
 *    `panels={{ intro: <>…</>, program: <>…</> }}` 처럼 **객체 prop** 으로 넘긴다 —
 *    `props` 만 따라가는 순회기는 거기서 멈춘다(처음 그렇게 짰다가 페이지 전체에서
 *    태그를 25개밖에 못 셌다. 상세 페이지가 25태그일 리 없다는 게 신호였다).
 */
function elements(node: unknown, tag: string): Array<Record<string, unknown>> {
  const seen = new Set<object>();
  const out: Array<Record<string, unknown>> = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n !== "object" || seen.has(n as object)) return;
    seen.add(n as object);
    if (Array.isArray(n)) return n.forEach(walk);
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (el.type === tag && el.props) out.push(el.props);
    // 엘리먼트면 props 를, 그냥 객체면 값 전부를 따라간다.
    Object.values(el.props ?? (n as Record<string, unknown>)).forEach(walk);
  };
  walk(node);
  return out;
}

async function render(schedules: Array<Record<string, unknown>>) {
  getPublicEventBySlug.mockResolvedValue(event(schedules));
  return EventDetailPage({
    params: Promise.resolve({ eventSlug: "bc-hankyung-klpga2026" }),
    searchParams: Promise.resolve({}),
  } as never);
}

beforeEach(() => {
  getPublicEventBySlug.mockReset();
});

describe("공개 상세 — 일정 안내 이미지", () => {
  it("🔴 그 일정의 이미지를, 그 일정의 제목을 단 <img> 로 그린다", async () => {
    const tree = await render([schedule({ imageUrl: IMG })]);
    const img = elements(tree, "img").find((p) => p.src === IMG);
    expect(img, "일정 이미지가 <img> 로 안 나왔다").toBeDefined();
    expect(String(img!.alt)).toContain("1라운드 조편성");
  });

  it("🔴 이미지가 없는 일정에는 안 붙는다 — 빈 src 로 깨진 이미지가 뜨면 안 된다", async () => {
    const tree = await render([schedule()]);
    const imgs = elements(tree, "img");
    expect(imgs.some((p) => !p.src || p.src === IMG)).toBe(false);
  });

  it("🔴 원본을 여는 길이 있다 — 폰에서 조편성표 글자는 축소되면 못 읽는다", async () => {
    const tree = await render([schedule({ imageUrl: IMG })]);
    const link = elements(tree, "a").find((p) => p.href === IMG);
    expect(link, "원본 링크가 없다").toBeDefined();
    expect(link!.target).toBe("_blank");
    // 새 창을 여는 링크는 rel 로 opener 를 끊는다.
    expect(String(link!.rel)).toContain("noopener");
  });

  it("일정이 둘이면 각자 자기 이미지를 단다 — 첫 장이 전부에 붙지 않는다", async () => {
    const second = "https://cdn.pickket.kr/uploads/general/round1-10.png";
    const tree = await render([
      schedule({ imageUrl: IMG }),
      schedule({ id: "s2", title: "10번 홀 출발", imageUrl: second, sortOrder: 1 }),
    ]);
    const a = elements(tree, "img").find((p) => p.src === IMG);
    const b = elements(tree, "img").find((p) => p.src === second);
    expect(String(a?.alt)).toContain("1라운드 조편성");
    expect(String(b?.alt)).toContain("10번 홀 출발");
  });
});
