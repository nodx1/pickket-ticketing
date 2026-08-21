import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BATCH_CLAIM_TTL_SECONDS,
  BATCH_RESULT_TTL_SECONDS,
  invitationBatchFingerprint,
  invitationBatchKey,
} from "./invitation-batch-key";

/**
 * 🔴 배치 지문은 **값이 바뀌면 사고**다.
 *
 * 이 값이 달라지면 어제 올린 명단의 저장된 키와 오늘 계산한 키가 안 맞아,
 * **같은 파일 재업로드가 "새 배치" 로 처리되어 명단 전원에게 한 장씩 더 나간다.**
 * 알림톡은 회수할 수 없다. 그래서 리팩터링으로도 값이 흔들리지 않게 고정한다.
 *
 * ## 왜 지금 쓰는가 (2026-07-31)
 * 이 파일에 **원시 제어문자**(U+0000·U+0001·U+0002)가 구분자로 박혀 있었다.
 * NUL 때문에 git 이 파일 전체를 **바이너리로 취급**해 diff·머지·리뷰가 통째로 안 보였다
 * (옆세션이 발견). 이스케이프(`\u0000` 등)로 바꿨고 **값은 동일**하다 —
 * 그 동일성을 사람 눈이 아니라 이 테스트가 보증한다.
 */

const EVENT = "867128f5-5cec-41de-81e0-b1eace7ce09b";
const LIST = [
  { phoneNormalized: "01011112222", admissionDay: null, admissionMode: "daypass" },
  { phoneNormalized: "01011112222", admissionDay: null, admissionMode: "daypass" },
  { phoneNormalized: "01033334444", admissionDay: "2026-08-20", admissionMode: "daypass" },
];

describe("invitationBatchFingerprint — 값 고정", () => {
  it("🔴 알려진 명단의 지문이 변하지 않는다", () => {
    // 제어문자 이스케이프 치환 **전에** 실측한 값이다. 바뀌면 재업로드가 재발급된다.
    expect(invitationBatchFingerprint(EVENT, LIST)).toBe(
      "96726c72e23e2099f38a9b99b86bfd9f526af1364fe729563f26be9a89b2f81f",
    );
  });

  it("구분자가 U+0001(필드) · U+0000(줄) · U+0002(이벤트) 그대로다", () => {
    // 상수를 독립적으로 재구성해 대조한다 — 소스의 이스케이프가 다른 코드포인트로
    // 바뀌면(예: \u0000 →  ) 위 해시와 함께 여기서도 죽는다.
    const lines = LIST.map((r) =>
      [r.phoneNormalized, r.admissionDay ?? "", r.admissionMode ?? ""].join("\u0001"),
    ).sort();
    const expected = createHash("sha256")
      .update(`${EVENT}\u0002${lines.join("\u0000")}`)
      .digest("hex");
    expect(invitationBatchFingerprint(EVENT, LIST)).toBe(expected);
  });
});

describe("invitationBatchFingerprint — 계약", () => {
  it("수신자가 0명이면 빈 문자열 — 호출측이 멱등 처리를 건너뛴다", () => {
    expect(invitationBatchFingerprint(EVENT, [])).toBe("");
  });

  it("순서를 바꿔도 같은 배치다 — 엑셀 정렬 변경 재업로드", () => {
    const reordered = [LIST[2]!, LIST[0]!, LIST[1]!];
    expect(invitationBatchFingerprint(EVENT, reordered)).toBe(
      invitationBatchFingerprint(EVENT, LIST),
    );
  });

  it("🔴 같은 번호가 3줄이면 2줄과 다른 배치다 — 다중집합으로 본다", () => {
    // 접으면 "3장 의도" 와 "2장 의도" 가 같은 키가 되어 3장째가 조용히 안 나간다.
    const two = [LIST[0]!, LIST[1]!];
    const three = [LIST[0]!, LIST[1]!, LIST[0]!];
    expect(invitationBatchFingerprint(EVENT, three)).not.toBe(
      invitationBatchFingerprint(EVENT, two),
    );
  });

  it("이벤트가 다르면 다른 배치다", () => {
    expect(invitationBatchFingerprint("other-event", LIST)).not.toBe(
      invitationBatchFingerprint(EVENT, LIST),
    );
  });

  it("입장일·입장모드가 다르면 다른 배치다", () => {
    const changed = [{ ...LIST[0]!, admissionDay: "2026-08-21" }];
    expect(invitationBatchFingerprint(EVENT, changed)).not.toBe(
      invitationBatchFingerprint(EVENT, [LIST[0]!]),
    );
  });

  it("이름은 키에 없다 — 오타 수정 재업로드가 새 배치가 되면 안 된다", () => {
    // 타입상 name 은 입력에 없다. 구조가 바뀌어 이름이 섞이면 이 테스트가 알려준다.
    const withName = [{ ...LIST[0]!, name: "홍길동" } as never];
    expect(invitationBatchFingerprint(EVENT, withName)).toBe(
      invitationBatchFingerprint(EVENT, [LIST[0]!]),
    );
  });
});

describe("키·TTL 계약", () => {
  it("Redis 키에 go: 접두사를 붙이지 않는다 — getPrefixedRedis 가 붙인다", () => {
    const k = invitationBatchKey(EVENT, "abc");
    expect(k).toBe(`invite-batch:${EVENT}:abc`);
    expect(k.startsWith("go:")).toBe(false);
  });

  it("🔴 진행중 TTL 이 결과 TTL 보다 훨씬 짧다", () => {
    // 뒤집히면 프로세스가 죽었을 때 그 명단이 7일간 재시도 불가가 된다.
    expect(BATCH_CLAIM_TTL_SECONDS).toBeLessThan(BATCH_RESULT_TTL_SECONDS);
    expect(BATCH_CLAIM_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});
