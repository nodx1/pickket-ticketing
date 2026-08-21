import { describe, it, expect } from "vitest";
import { parseRecipients } from "./parse-recipients";

describe("parseRecipients", () => {
  it("콤마 구분 명단을 파싱한다", () => {
    const r = parseRecipients("홍길동, 01012345678\n김철수, 01098765432");
    expect(r.errors).toHaveLength(0);
    expect(r.recipients).toEqual([
      { name: "홍길동", phone: "01012345678" },
      { name: "김철수", phone: "01098765432" },
    ]);
  });

  it("탭 구분·헤더 행·빈 줄을 처리한다", () => {
    const r = parseRecipients("이름\t전화번호\n\n홍길동\t01012345678\n");
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0]).toEqual({ name: "홍길동", phone: "01012345678" });
  });

  it("이름/전화번호 누락은 오류로 기록한다", () => {
    const r = parseRecipients("홍길동\n, 01011112222");
    expect(r.recipients).toHaveLength(0);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0].reason).toContain("전화번호");
    expect(r.errors[1].reason).toContain("이름");
  });

  it("하이픈·공백 휴대폰 번호를 숫자만으로 정규화한다", () => {
    const r = parseRecipients("홍길동, 010-1234-5678\n김철수, 010 9876 5432");
    expect(r.errors).toHaveLength(0);
    expect(r.recipients).toEqual([
      { name: "홍길동", phone: "01012345678" },
      { name: "김철수", phone: "01098765432" },
    ]);
  });

  it("잘못된 휴대폰 형식(단자리·문자·유선·열밀림)을 오류로 기록한다", () => {
    const single = parseRecipients("홍길동, 010-9999");
    expect(single.recipients).toHaveLength(0);
    expect(single.errors[0].reason).toContain("휴대폰 번호 형식");

    const alpha = parseRecipients("홍길동, abc");
    expect(alpha.recipients).toHaveLength(0);
    expect(alpha.errors[0].reason).toContain("휴대폰 번호 형식");

    const landline = parseRecipients("홍길동, 0212345678");
    expect(landline.recipients).toHaveLength(0);
    expect(landline.errors[0].reason).toContain("휴대폰 번호 형식");

    // 열밀림: 전화번호 칸에 이름/숫자가 아닌 값이 들어온 경우.
    const shifted = parseRecipients("010, 홍길동, 01012345678");
    expect(shifted.recipients).toHaveLength(0);
    expect(shifted.errors[0].reason).toContain("휴대폰 번호 형식");
  });

  it("daypass: 지정일 필수·형식·기간 검증", () => {
    const opts = { requireAdmissionDay: true, validDays: ["2026-10-03", "2026-10-04"] };
    const ok = parseRecipients("홍길동, 01012345678, 2026-10-03", opts);
    expect(ok.errors).toHaveLength(0);
    expect(ok.recipients[0].admissionDay).toBe("2026-10-03");

    const missing = parseRecipients("홍길동, 01012345678", opts);
    expect(missing.errors[0].reason).toContain("지정일");

    const badFormat = parseRecipients("홍길동, 01012345678, 20261003", opts);
    expect(badFormat.errors[0].reason).toContain("형식");

    const outOfRange = parseRecipients("홍길동, 01012345678, 2026-10-09", opts);
    expect(outOfRange.errors[0].reason).toContain("기간");
  });

  it("single: 세 번째 열이 있어도 admissionDay 로 수용(형식 유효 시)", () => {
    const r = parseRecipients("홍길동, 01012345678, 2026-10-03");
    expect(r.errors).toHaveLength(0);
    expect(r.recipients[0].admissionDay).toBe("2026-10-03");
  });
});
