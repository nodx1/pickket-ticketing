import { describe, expect, it } from "vitest";

import { ADD_QTY_MAX, addOneRecipient, countByPhone, mergeRecipients, removeAt, repeatRecipient } from "./staging";
import type { ParsedRecipient } from "./parse-recipients";

/**
 * 🔴 여기가 틀어지면 **수신자가 조용히 빠지거나 두 번 들어간다.**
 * 화면에는 그럴듯하게 보이므로 눈으로는 못 잡는다.
 */
const r = (name: string, phone: string, day?: string): ParsedRecipient =>
  day ? { name, phone, admissionDay: day } : { name, phone };

const DAYS = ["2026-08-20", "2026-08-21"];

describe("mergeRecipients — 목록 합치기", () => {
  it("새 수신인을 뒤에 붙이고 순서를 유지한다", () => {
    const out = mergeRecipients([r("홍길동", "01011112222")], [r("김철수", "01033334444")]);
    expect(out.map((x) => x.name)).toEqual(["홍길동", "김철수"]);
  });

  /**
   * 🔴 폐기된 요구 3건 (2026-07-31) — 종전엔 번호별로 **접기**를 요구했다:
   *   · "이미 목록에 있는 번호는 버린다 — v2 는 한 번호당 1장"
   *   · "새로 들어온 묶음 안의 중복도 버린다"
   *   · "표기가 달라도 같은 번호로 본다"
   * 전제(v2 `UNIQUE(event, phone)`)가 `UNIQUE(event, phone, seq)` 로 바뀌어
   * **한 번호당 최대 5장**이 됐다. 접으면 서버가 열어둔 5장을 화면이 1장으로 줄인다 —
   * 실제로 배포본이 그 상태였고, 게이트는 전부 그린이었다.
   */
  it("🔴 같은 번호를 넣은 만큼 담는다 — 1인 다장", () => {
    const out = mergeRecipients([r("홍길동", "01011112222")], [r("홍길동", "01011112222")]);
    expect(out).toHaveLength(2);
  });

  it("🔴 한 묶음 안의 같은 번호 3줄도 3줄로 담는다 — 붙여넣기 경로", () => {
    const out = mergeRecipients([], [
      r("A", "01011112222"), r("A", "01011112222"), r("A", "01011112222"),
    ]);
    expect(out).toHaveLength(3);
  });

  it("표기가 달라도 담는다 — 접지 않으므로 정규화는 표시·집계용일 뿐", () => {
    const out = mergeRecipients([r("홍길동", "01011112222")], [r("홍길동", "010-1111-2222")]);
    expect(out).toHaveLength(2);
  });

  it("🔴 상한 5장을 화면이 세지 않는다 — 6줄도 그대로 담는다(판정은 v2 의 409)", () => {
    // 화면이 세면 동시 요청에 뚫리고, 정본은 v2 의 CHECK(1..5)+409 다.
    // 초과분은 서버가 atLimit 으로 되돌려 준다.
    const six = Array.from({ length: 6 }, () => r("A", "01011112222"));
    expect(mergeRecipients([], six)).toHaveLength(6);
  });

  it("빈 번호는 목록에 넣지 않는다", () => {
    expect(mergeRecipients([], [r("이름만", "")])).toHaveLength(0);
  });

  it("원본 배열을 변형하지 않는다", () => {
    const prev = [r("홍길동", "01011112222")];
    mergeRecipients(prev, [r("김철수", "01033334444")]);
    expect(prev).toHaveLength(1);
  });
});

describe("addOneRecipient — 한 명씩 추가", () => {
  it("정상 입력이면 통과한다", () => {
    const res = addOneRecipient({ name: "홍길동", phone: "01011112222", requireAdmissionDay: false, staged: [] });
    expect(res).toMatchObject({ ok: true, recipient: { name: "홍길동" } });
  });

  it("🔴 붙여넣기와 **같은 파서**를 쓴다 — 잘못된 번호는 여기서도 거부", () => {
    // 규칙을 따로 짜면 한쪽은 통과하고 한쪽은 거부돼 주최자가 혼란스러워진다.
    const res = addOneRecipient({ name: "홍길동", phone: "123", requireAdmissionDay: false, staged: [] });
    expect(res.ok).toBe(false);
  });

  it("이름이 비면 거부", () => {
    expect(addOneRecipient({ name: "", phone: "01011112222", requireAdmissionDay: false, staged: [] }).ok).toBe(false);
  });

  it("🔴 지정일권인데 입장일이 없으면 거부", () => {
    const res = addOneRecipient({ name: "홍길동", phone: "01011112222", requireAdmissionDay: true, validDays: DAYS, staged: [] });
    expect(res.ok).toBe(false);
  });

  it("🔴 대회 기간 밖 입장일은 거부", () => {
    const res = addOneRecipient({
      name: "홍길동", phone: "01011112222", admissionDay: "2026-10-03",
      requireAdmissionDay: true, validDays: DAYS, staged: [],
    });
    expect(res.ok).toBe(false);
  });

  it("대회 기간 내 입장일은 통과하고 그 날짜가 실린다", () => {
    const res = addOneRecipient({
      name: "홍길동", phone: "01011112222", admissionDay: DAYS[1],
      requireAdmissionDay: true, validDays: DAYS, staged: [],
    });
    expect(res).toMatchObject({ ok: true, recipient: { admissionDay: DAYS[1] } });
  });

  /**
   * 🔴 폐기된 요구 (2026-07-31)
   * 종전: `{ ok:false, reason:"이미 목록에 있는 번호입니다" }` 를 요구했다.
   * **1인 다장(최대 5장)이 요건**이 되면서 그 거부가 곧 결함이 됐다 —
   * 서버는 dedupe 를 지웠는데 화면이 2장째를 못 담았다.
   */
  it("🔴 같은 번호를 다시 추가할 수 있다 — 1인 다장", () => {
    const res = addOneRecipient({
      name: "홍길동", phone: "010-1111-2222", requireAdmissionDay: false,
      staged: [r("먼저", "01011112222")],
    });
    expect(res.ok).toBe(true);
  });
});

describe("removeAt — 그 줄 하나만 제거", () => {
  it("🔴 같은 번호가 여러 줄이어도 지목한 줄만 지운다", () => {
    // 번호로 지우면 3줄이 한꺼번에 사라진다 — 1인 다장에서 실제로 겪을 함정.
    const out = removeAt([r("A", "01011112222"), r("A", "01011112222"), r("B", "01033334444")], 1);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.name)).toEqual(["A", "B"]);
  });

  it("범위 밖 인덱스는 아무것도 지우지 않는다", () => {
    const staged = [r("A", "01011112222")];
    expect(removeAt(staged, 5)).toHaveLength(1);
    expect(removeAt(staged, -1)).toHaveLength(1);
  });
});

describe("countByPhone — 표시용 장수", () => {
  it("번호별로 센다(표기 차이 흡수)", () => {
    const m = countByPhone([r("A", "010-1111-2222"), r("A", "01011112222"), r("B", "01033334444")]);
    expect(m.get("01011112222")).toBe(2);
    expect(m.get("01033334444")).toBe(1);
  });

  it("전화번호를 못 뽑는 줄은 세지 않는다", () => {
    expect(countByPhone([r("A", "")]).size).toBe(0);
  });
});

/**
 * 장수 입력 — 같은 번호를 손으로 N 번 치지 않게 한다 (2026-07-31 대표 요청).
 *
 * 🔴 여기가 틀어지면 **주최자가 고른 장수와 실제 나가는 장수가 달라진다.**
 *    화면 목록에는 담긴 줄이 그대로 보이므로 이 함수만 맞으면 눈으로 확인이 된다.
 */
describe("repeatRecipient", () => {
  const one = r("홍길동", "01011112222");

  it("고른 장수만큼 줄을 만든다", () => {
    expect(repeatRecipient(one, 3)).toHaveLength(3);
    expect(repeatRecipient(one, 3).every((x) => x.phone === "01011112222")).toBe(true);
  });

  it("1장이면 1줄 — 종전 동작과 같다", () => {
    expect(repeatRecipient(one, 1)).toEqual([one]);
  });

  it.each([0, -1, 0.4, NaN])("이상한 값(%p)은 1줄로 떨어진다 — 0줄이 되어 조용히 안 나가면 안 된다", (q) => {
    expect(repeatRecipient(one, q as number)).toHaveLength(1);
  });

  it(`상한(${ADD_QTY_MAX}) 을 넘겨도 그 이상 담기지 않는다 — 한 번의 추가로 상한을 넘는 줄이 들어가는 오조작 방지`, () => {
    expect(repeatRecipient(one, 99)).toHaveLength(ADD_QTY_MAX);
  });

  it("🔴 줄마다 **다른 객체**여야 한다 — 같은 참조면 한 줄 삭제가 다른 줄에 번진다", () => {
    const [a, b] = repeatRecipient(one, 2);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("목록에 합치면 그 번호의 장수가 그만큼 늘어난다(countByPhone 과 맞물린다)", () => {
    const staged = mergeRecipients([], repeatRecipient(one, 3));
    expect(countByPhone(staged).get("01011112222")).toBe(3);
    expect(removeAt(staged, 0)).toHaveLength(2);
  });
});


/**
 * 🔴 화면 상한 값 자체를 고정한다 — **요구사항**이지 구현 세부가 아니다.
 *
 * 위 테스트들은 전부 `ADD_QTY_MAX` 를 **참조**하므로 값을 바꾸면 같이 움직인다
 * ⟹ 누가 5 로 되돌려도 스위트는 전부 초록이다(2026-08-10 뮤테이션으로 실증).
 * 그러면 서버는 50 을 받는데 **화면이 5장까지만 고를 수 있다** — 대표가 실제로
 * 그 상태를 보고 "아직 최대 5장이라 나오는데?" 라고 지적했다.
 *
 * ⚠️ 리터럴 중복은 보통 나쁘지만 여기서는 의도적이다 — v2 의
 *    `INVITATION_MAX_PER_PHONE`(=50) 과 **같은 수여야 한다**는 계약을 이 줄이 지킨다.
 *    v2 쪽에도 대칭인 테스트가 있다(test_cap_is_fifty_by_requirement).
 */
describe("🔴 화면 상한은 서버 상한과 같아야 한다", () => {
  it("ADD_QTY_MAX 가 50 이다 (v2 INVITATION_MAX_PER_PHONE 과 동일)", () => {
    expect(ADD_QTY_MAX, "서버는 50 을 받는데 화면이 더 적게 고르게 하면 기능이 반쪽이다").toBe(50);
  });
});
