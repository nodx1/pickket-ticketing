/**
 * 🔴 결제 3단계에서 영수증 입력을 걷어낸 것 (2026-08-01 지시서 ①).
 *
 * 카드 결제는 카드사가 이미 영수증을 발행한다. 15,000원 티켓을 사면서 세금계산서를 묻고
 * 그 옆에 「현금영수증(준비 중)」이 떠 있었다 — 구매자는 "안 고르면 손해인가?" 하고
 * **결제 직전에 멈춘다.** 게다가 `issueTaxInvoice()`·`issueCashReceipt()` 는 스텁이고
 * 주최자 대시보드에 발행 화면이 없다 — **묻기만 하고 아무 일도 안 일어나는 입력**이었다.
 *
 * ⚠️ 서버는 건드리지 않았다. `initiate` 의 zod `receiptType` 은 optional 이라 안 보내면
 *    그만이고, `lib/tax/*` 는 나중에 주최자 영수증 기능을 붙일 때 쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const DETAILS = "app/(public)/e/[eventSlug]/checkout/details/_components/checkout-details-step.tsx";
const PAYMENT = "app/(public)/e/[eventSlug]/checkout/payment/_components/checkout-payment-step.tsx";
const STORE = "lib/stores/checkoutStore.ts";

describe("영수증 입력 제거", () => {
  it("§0 대상 파일을 실제로 읽었다 (경로 오타로 조용히 통과 방지)", () => {
    for (const f of [DETAILS, PAYMENT, STORE]) expect(read(f).length).toBeGreaterThan(1000);
  });

  it("🔴 결제 화면에 영수증 선택지가 없다", () => {
    const src = read(DETAILS);
    for (const gone of ["영수증 발행", "세금계산서", "현금영수증", "사업자등록번호", "NICE 계약 배선"]) {
      // 주석에 사유를 남겼으므로 코드에서만 사라졌는지 본다
      const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `"${gone}" 가 화면에 남아 있다`).not.toContain(gone);
    }
  });

  it("🔴 결제 개시에 영수증 필드를 싣지 않는다", () => {
    const code = read(PAYMENT).replace(/\/\/.*$/gm, "");
    for (const k of ["receiptType", "businessNumber", "companyName", "identityNumber"]) {
      expect(code, `${k} 를 아직 보낸다`).not.toContain(k);
    }
  });

  it("🔴 스토어에서도 사라졌다 — 남기면 저장만 되는 죽은 필드가 된다", () => {
    const code = read(STORE).replace(/\/\/.*$/gm, "");
    for (const k of ["receiptType", "businessNumber", "companyName", "identityNumber"]) {
      expect(code, `${k} 가 스토어에 남아 있다`).not.toContain(k);
    }
  });

  it("⚠️ 서버 스키마는 그대로 둔다 — 지우면 v2 계약과 어긋난다", () => {
    const route = read("app/api/checkout/initiate/route.ts");
    // ⚠️ `toContain("receiptType")` 로는 부족하다 — `receiptTypeREMOVED` 로 바꿔도 통과한다
    //    (실측: 그렇게 만들었더니 뮤테이션이 생존했다). **zod 키 자체**를 본다.
    expect(route, "zod receiptType 을 지웠다 — 지시서가 남기라고 한 것").toMatch(
      /\breceiptType\s*:\s*z\./,
    );
    expect(fs.existsSync(path.join(SRC, "lib", "tax")), "lib/tax 를 지웠다").toBe(true);
  });
});
