/**
 * 접힘 상태 저장 포맷 회귀 테스트 (2026-07-29 · 2026-08-01 갱신).
 *
 * 지키는 것:
 *  ① 구버전(라벨 키) 데이터를 만나면 접힘을 리셋한다.
 *  ② 사라진 그룹의 고아 키가 무한 잔류하지 않는다.
 *  ③ 저장 포맷에 버전이 박힌다.
 *  ④ 🔴 「자주 사용」 제거(2026-08-01) 후에도 **접힘 상태는 살아남는다.**
 *     그 기능을 걷어내면서 `STORAGE_VERSION` 을 올리고 싶은 유혹이 있는데, 올리면
 *     전 사용자의 접힘 설정이 리셋된다. 사라진 키는 안 읽으면 그만이다.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_COLLAPSED_GROUP_IDS, EVENT_SIDEBAR_GROUP_IDS } from "@/components/layout/event-sidebar-groups";
import { readStoredPrefs, serializePrefs } from "./uiPreferencesStore";

describe("readStoredPrefs — 저장 포맷 마이그레이션", () => {
  it("저장값이 없으면 기본 접힘으로 시작한다", () => {
    expect(readStoredPrefs(null).collapsedGroups).toEqual([...DEFAULT_COLLAPSED_GROUP_IDS]);
  });

  it("구버전(라벨 키, v 없음) → 접힘 리셋", () => {
    const legacy = JSON.stringify({
      collapsedGroups: ["이벤트 준비", "추가 도구", "공지·안내"], // 전부 사라진 라벨
    });
    const out = readStoredPrefs(legacy);

    // 고아 라벨이 하나도 살아남지 않는다
    expect(out.collapsedGroups).toEqual([...DEFAULT_COLLAPSED_GROUP_IDS]);
    for (const id of out.collapsedGroups) {
      expect(EVENT_SIDEBAR_GROUP_IDS).toContain(id);
    }
  });

  it("현재 버전 데이터는 접힘을 그대로 복원한다", () => {
    const out = readStoredPrefs(serializePrefs(new Set(["sell"])));
    expect(out.collapsedGroups).toEqual(["sell"]);
  });

  it("사용자가 모두 펼친 상태(빈 배열)를 기본값으로 되돌리지 않는다", () => {
    expect(readStoredPrefs(serializePrefs(new Set([]))).collapsedGroups).toEqual([]);
  });

  it("깨진 JSON 이면 기본값으로 안전 복구한다", () => {
    expect(readStoredPrefs("{not json").collapsedGroups).toEqual([...DEFAULT_COLLAPSED_GROUP_IDS]);
  });

  /**
   * 🔴 「자주 사용」을 쓰던 사용자의 저장값에는 `itemUsageCount` 가 남아 있다.
   * 그 키 때문에 접힘 설정이 날아가면 안 된다 — 기능 하나 걷어냈다고 사용자 설정을
   * 리셋하는 셈이 된다.
   */
  it("옛 itemUsageCount 키가 남아 있어도 접힘은 보존된다", () => {
    // ⚠️ `v` 를 **리터럴 2** 로 박는다. `serializePrefs()` 에서 뽑으면 버전을 따라가버려
    //    버전을 올려도 이 검사가 통과한다(실측: 그렇게 만들었다가 뮤테이션이 생존했다).
    //    리터럴이라야 "버전을 올렸다"는 사실 자체가 여기서 걸린다.
    // ⚠️ 접힘 값도 **기본값과 다른 것**을 쓴다. 기본값(comms·advanced)을 쓰면 리셋돼도
    //    결과가 같아 통과한다(실측: 그렇게 만들었다가 뮤테이션이 또 생존했다).
    const withLegacyKey = JSON.stringify({
      v: 2,
      collapsedGroups: ["sell"],
      itemUsageCount: { "/events/e1/orders": 42 }, // 제거된 기능의 잔재
    });
    expect(
      readStoredPrefs(withLegacyKey).collapsedGroups,
      "버전을 올렸다면 전 사용자의 접힘 설정이 리셋된다 — 의도한 것인지 확인하고 이 테스트를 고칠 것",
    ).toEqual(["sell"]);
  });
});

describe("serializePrefs", () => {
  it("버전이 포함된다 — 다음 IA 변경 때 마이그레이션 판정 근거", () => {
    const parsed = JSON.parse(serializePrefs(new Set(["comms"]))) as { v?: number };
    expect(parsed.v).toBeTypeOf("number");
  });

  it("직렬화 → 역직렬화 왕복이 보존된다", () => {
    const groups = new Set(["comms", "advanced"]);
    expect(new Set(readStoredPrefs(serializePrefs(groups)).collapsedGroups)).toEqual(groups);
  });

  it("🔴 제거된 사용횟수를 다시 쓰지 않는다 — 죽은 키를 남기지 않기 위해", () => {
    const parsed = JSON.parse(serializePrefs(new Set(["sell"]))) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["collapsedGroups", "v"]);
  });
});
