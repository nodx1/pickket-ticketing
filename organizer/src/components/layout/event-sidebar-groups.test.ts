/**
 * 사이드바 IA 회귀 테스트 (2026-07-29 5그룹 재편).
 *
 * 이 테스트가 지키는 것:
 *  ① **그룹은 어떤 토글 조합에서도 사라지지 않는다** — 재편의 핵심 불변식.
 *  ② 접힘 저장 키(id)가 라벨과 분리돼 있다 — 라벨을 바꿔도 사용자 접힘이 유지된다.
 *  ③ 물리 경로 보존 — 딥링크·북마크가 깨지지 않는다.
 *  ④ 게이트 항목이 토글 off 에서 실제로 숨는다.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSED_GROUP_IDS,
  EVENT_SIDEBAR_GROUP_IDS,
  EVIDENCE_MENU,
  evidenceMenuGroups,
  menuGroups,
  pinnedItem,
  visibleGroupsFor,
} from "./event-sidebar-groups";

/** 재편 전 사이드바에 있던 전체 경로. campaigns 만 제거됐다(메시지로 흡수). */
const PATHS_BEFORE_REORG = [
  "getting-started", "publish", "settings", "schedules", "tickets", "products",
  "questions", "homepage-designer",
  "dashboard", "bids", "orders", "attendees", "check-in", "raffle", "reports",
  "inbox", "inquiries", "messages", "campaigns", "open-notices",
  "promo-codes", "affiliates", "ticket-designer",
  "capacity", "waitlist", "webhooks", "widget",
  "group-bookings", "participants", "facilities",
  "ticket-issuance", "invitations", "invitation-designer",
];

const ALL_GATES = {
  enabledFeatures: ["group_booking", "participants", "facilities", "ticket_issuance"],
  hasLotteryPhase: true,
  raffleEnabled: true,
};
const NO_GATES = { enabledFeatures: [], hasLotteryPhase: false, raffleEnabled: false };

function allHrefs() {
  return [pinnedItem.href, ...menuGroups.flatMap((g) => g.items.map((i) => i.href))];
}

describe("사이드바 그룹 구성", () => {
  it("5그룹이며 id 는 고정값이다", () => {
    expect(EVENT_SIDEBAR_GROUP_IDS).toEqual(["prepare", "sell", "onsite", "comms", "advanced"]);
  });

  it("그룹 id 가 중복되지 않는다 (접힘 상태 충돌 방지)", () => {
    expect(new Set(EVENT_SIDEBAR_GROUP_IDS).size).toBe(EVENT_SIDEBAR_GROUP_IDS.length);
  });

  it("id 가 라벨과 분리돼 있다 — 라벨을 키로 쓰면 라벨 변경 시 접힘이 리셋된다", () => {
    for (const g of menuGroups) {
      expect(g.id).not.toBe(g.label);
      expect(g.id).toMatch(/^[a-z]+$/); // 한글 라벨과 절대 겹치지 않는 형태
    }
  });

  it("기본 접힘 그룹은 실재하는 id 만 가리킨다", () => {
    for (const id of DEFAULT_COLLAPSED_GROUP_IDS) {
      expect(EVENT_SIDEBAR_GROUP_IDS).toContain(id);
    }
  });

  it("최초 방문에 전 그룹이 펼쳐지지 않는다 (예전 new Set() 회귀 방지)", () => {
    expect(DEFAULT_COLLAPSED_GROUP_IDS.length).toBeGreaterThan(0);
    // 그렇다고 전부 접혀 있어도 안 된다 — 진입 시 아무것도 안 보인다.
    expect(DEFAULT_COLLAPSED_GROUP_IDS.length).toBeLessThan(EVENT_SIDEBAR_GROUP_IDS.length);
  });

  it("항목 경로가 중복되지 않는다", () => {
    const hrefs = allHrefs();
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("불변식 — 그룹은 토글로 사라지지 않는다", () => {
  it("모든 게이트가 꺼져도 5그룹이 전부 남는다", () => {
    const visible = visibleGroupsFor(NO_GATES);
    expect(visible.map((g) => g.id)).toEqual(EVENT_SIDEBAR_GROUP_IDS);
  });

  it("각 그룹은 게이트 없는 항목을 2개 이상 갖는다", () => {
    for (const g of menuGroups) {
      const ungated = g.items.filter(
        (i) => !i.requiredFeature && !i.requiresLotteryPhase && !i.requiresRaffle,
      );
      expect(
        ungated.length,
        `그룹 "${g.label}"(${g.id}) 의 게이트 없는 항목이 ${ungated.length}개 — 토글이 꺼지면 그룹이 사라질 수 있다`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("어떤 토글 조합에서도(2^4 × lottery × raffle) 그룹 수가 5로 유지된다", () => {
    const feats = ["group_booking", "participants", "facilities", "ticket_issuance"];
    for (let mask = 0; mask < 1 << feats.length; mask++) {
      const enabledFeatures = feats.filter((_, i) => mask & (1 << i));
      for (const hasLotteryPhase of [true, false]) {
        for (const raffleEnabled of [true, false]) {
          const visible = visibleGroupsFor({ enabledFeatures, hasLotteryPhase, raffleEnabled });
          expect(
            visible.length,
            `조합 features=[${enabledFeatures}] lottery=${hasLotteryPhase} raffle=${raffleEnabled}`,
          ).toBe(5);
        }
      }
    }
  });
});

describe("물리 경로 보존 (딥링크·북마크)", () => {
  it("campaigns 를 제외한 재편 전 경로가 전부 살아있다", () => {
    const now = new Set(allHrefs());
    const missing = PATHS_BEFORE_REORG.filter((p) => p !== "campaigns" && !now.has(p));
    expect(missing, `사라진 경로: ${missing.join(", ")}`).toEqual([]);
  });

  it("이메일 캠페인은 사이드바에서 빠졌다 (라우트는 messages 로 redirect 되어 존치)", () => {
    expect(allHrefs()).not.toContain("campaigns");
    expect(allHrefs()).toContain("messages");
  });

  it("대시보드는 그룹이 아니라 고정 항목이다", () => {
    expect(pinnedItem.href).toBe("dashboard");
    expect(menuGroups.flatMap((g) => g.items.map((i) => i.href))).not.toContain("dashboard");
  });

  it("용량 관리는 흡수되지 않고 제자리에 있다 (capacity_assignments 는 별도 저장소)", () => {
    const advanced = menuGroups.find((g) => g.id === "advanced");
    expect(advanced?.items.map((i) => i.href)).toContain("capacity");
  });
});

describe("게이트 필터", () => {
  it("ticket_issuance off → 발권 3종이 숨는다", () => {
    const hrefs = visibleGroupsFor(NO_GATES).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("ticket-issuance");
    expect(hrefs).not.toContain("invitations");
    expect(hrefs).not.toContain("invitation-designer");
  });

  it("ticket_issuance on → 발권 3종이 판매·발권 그룹에 나타난다", () => {
    const sell = visibleGroupsFor({ ...NO_GATES, enabledFeatures: ["ticket_issuance"] })
      .find((g) => g.id === "sell");
    const hrefs = sell?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("ticket-issuance");
    expect(hrefs).toContain("invitations");
    expect(hrefs).toContain("invitation-designer");
  });

  it("raffle off → 경품 추첨이 숨고, on → 현장 그룹에 나타난다", () => {
    const off = visibleGroupsFor(NO_GATES).find((g) => g.id === "onsite");
    expect(off?.items.map((i) => i.href)).not.toContain("raffle");

    const on = visibleGroupsFor({ ...NO_GATES, raffleEnabled: true }).find((g) => g.id === "onsite");
    expect(on?.items.map((i) => i.href)).toContain("raffle");
  });

  it("lottery phase 없음 → 응모 현황이 숨는다", () => {
    const hrefs = visibleGroupsFor(NO_GATES).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("bids");
    const on = visibleGroupsFor({ ...NO_GATES, hasLotteryPhase: true })
      .flatMap((g) => g.items.map((i) => i.href));
    expect(on).toContain("bids");
  });

  it("전 게이트 on 이면 재편 후 전체 항목이 노출된다", () => {
    const visible = visibleGroupsFor(ALL_GATES);
    const count = visible.reduce((n, g) => n + g.items.length, 0);
    // 재편 전 33 − campaigns 1 − 대시보드(고정으로 분리) 1 = 31
    // + 과업(2026-11): 가중치 추첨 설정·공정성 증명서·현장 입장 관리·정산 방식 4 = 35
    expect(count).toBe(35);
  });
});

describe("현장 그룹 — 대회 당일 게이트", () => {
  it("체크인은 어떤 토글에서도 항상 노출된다", () => {
    const onsite = visibleGroupsFor(NO_GATES).find((g) => g.id === "onsite");
    expect(onsite?.items.map((i) => i.href)).toContain("check-in");
    expect(onsite?.items.map((i) => i.href)).toContain("attendees");
  });
});

describe("과업 증빙용 간단 메뉴", () => {
  const all = { enabledFeatures: ["ticket_issuance", "group_booking", "participants", "facilities"], hasLotteryPhase: true, raffleEnabled: true };
  it("시연 동선 메뉴만 남고 순서가 고정된다", () => {
    const groups = evidenceMenuGroups(visibleGroupsFor(all));
    expect(groups.map((g) => [g.id, g.items.map((i) => i.href)])).toEqual([
      ["prepare", ["settings", "tickets", "publish"]],
      ["sell", ["orders", "lottery-policy", "bids", "fairness", "settlement"]],
      ["onsite", ["attendees", "onsite"]],
    ]);
  });
  it("그룹 이름은 원래 메뉴 이름을 쓴다", () => {
    expect(evidenceMenuGroups(visibleGroupsFor(all)).map((g) => g.label)).toEqual(["준비", "판매·발권", "현장"]);
  });
  it("추첨 단계가 없으면 추첨 메뉴 3개는 계속 숨는다(게이트 유지)", () => {
    const sell = evidenceMenuGroups(visibleGroupsFor({ hasLotteryPhase: false })).find((g) => g.id === "sell");
    expect(sell?.items.map((i) => i.href)).toEqual(["orders", "settlement"]);
  });
  it("간단 메뉴의 경로는 모두 원래 메뉴에 실재한다", () => {
    const hrefs = new Set(menuGroups.flatMap((g) => g.items.map((i) => i.href)));
    for (const { hrefs: hs } of EVIDENCE_MENU) for (const h of hs) expect(hrefs.has(h)).toBe(true);
  });
});
