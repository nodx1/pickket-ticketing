/**
 * `ConfirmDialog` 배선 회귀 검사 (2026-07-30, S1/S1b).
 *
 * ── 이 검사가 필요한 이유 ──
 * `pending` 은 UI prop 이라 순수 판정 함수가 없다. 단위 테스트로는 "잠겼는지"를 증명할 수 없고,
 * 실동작은 Playwright 로 봐야 한다(별건). 그 사이를 메우는 것이 **배선 검사**다 —
 * 비가역 동작 화면에서 누가 `pending={...}` 을 지웠을 때 여기서 잡힌다. E2E 보다 싸고 빠르다.
 *
 * ── 이 검사가 증명하지 않는 것 ──
 * "버튼이 실제로 disabled 된다" 는 증명하지 않는다. 소스에 prop 이 전달되어 있다는 것만 본다.
 * 또한 **응답 유실 + 네트워크 미복구** 경로는 UI 로 닫을 수 없다 — 서버측 멱등(별건)의 몫이다.
 *
 * ⚠️ 경로가 틀리면 파일을 못 읽고 조용히 통과할 수 있다. 그래서 §0 에서 **파일 존재를 먼저
 *    단언**한다(다른 세션이 경로 중복으로 21건 전건 실패한 전례가 있다).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "app", "(dashboard)");

/** 주석을 걷어낸다 — 주석에 적힌 `pending=` 을 배선으로 오인하지 않기 위해. */
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function codeOf(rel: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/**
 * `<ConfirmDialog ... >` 속성 블록만 추출.
 *
 * 중첩 `{}` 를 세는 이유: `onOpenChange={(v) => setOpen(v)}` 처럼 **화살표 함수의 `>`** 가
 * 속성값 안에 들어온다. 단순히 첫 `>` 까지 자르면 블록이 잘려 `pending=` 을 놓친다.
 */
function dialogProps(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<ConfirmDialog\b/g)) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && (src.startsWith("/>", i) || ch === ">")) {
        out.push(src.slice(start, i));
        break;
      }
      i++;
    }
  }
  return out;
}

/** 비가역 동작 — 확인 버튼이 잠겨야 하는 화면. */
const IRREVERSIBLE = [
  {
    label: "이벤트 삭제",
    rel: "events/[eventId]/settings/_components/event-danger-zone.tsx",
    state: "submitting",
  },
  {
    label: "이벤트 상태전환(게시·취소·보관)",
    rel: "events/[eventId]/settings/_components/event-status-card.tsx",
    state: "submitting",
  },
] as const;

/** 실패 경로에서도 서버 상태를 다시 읽어야 하는 금전 화면. */
const MONEY = [
  {
    label: "환불",
    rel: "events/[eventId]/orders/[orderId]/_components/order-refund-action.tsx",
  },
  {
    label: "입금확정",
    rel: "events/[eventId]/orders/[orderId]/_components/order-deposit-confirm-action.tsx",
  },
  {
    label: "이벤트 상태전환",
    rel: "events/[eventId]/settings/_components/event-status-card.tsx",
  },
] as const;

/**
 * §0-A 헬퍼 자체 검증 — **합성 입력**으로 판정 로직을 증명한다.
 *
 * 실제 소스만으로 검증하면, 소스에 우연히 그 케이스가 없을 때 보호장치가 **작동하는지
 * 알 수 없다**(자체 뮤테이션에서 실제로 드러났다: 주석 제거를 꺼도 전건 통과 —
 * 현재 소스에 `pending=` 을 담은 주석이 없어서였다). 합성 입력이 그 공백을 메운다.
 */
describe("§0-A 판정 헬퍼가 실제로 동작한다 (합성 입력)", () => {
  // ⚠️ 주석은 **속성 블록 안**에 둬야 의미가 있다. 태그 바깥에 두면 추출기가 애초에
  //    건드리지 않아, 주석 제거를 꺼도 통과한다(자체 뮤테이션에서 실제로 드러난 결함).
  //    실제로 위험한 형태도 이것이다 — 누가 배선을 주석 처리해두는 경우.
  it("속성 블록 안의 라인주석에 적힌 pending= 은 배선으로 세지 않는다", () => {
    const src = [
      "<ConfirmDialog",
      "  open={o}",
      "  // pending={submitting}  ← 주석 처리됨, 실제 배선 아님",
      "  onConfirm={f}",
      "/>",
    ].join("\n");
    const blocks = dialogProps(stripComments(src));
    expect(blocks).toHaveLength(1);
    expect(/\bpending\s*=/.test(blocks[0])).toBe(false);
  });

  it("속성 블록 안의 블록주석에 적힌 pending= 도 세지 않는다", () => {
    const src = `<ConfirmDialog open={o} /* pending={x} */ onConfirm={f} />`;
    const blocks = dialogProps(stripComments(src));
    expect(blocks).toHaveLength(1);
    expect(/\bpending\s*=/.test(blocks[0])).toBe(false);
  });

  it("진짜 배선은 센다", () => {
    const src = `<ConfirmDialog open={o} pending={submitting} onConfirm={f} />`;
    expect(dialogProps(stripComments(src)).some((b) => /\bpending\s*=/.test(b))).toBe(true);
  });

  it("화살표 함수의 > 때문에 블록이 잘리지 않는다", () => {
    const src = `<ConfirmDialog onOpenChange={(v) => setOpen(v)} pending={busy} />`;
    const blocks = dialogProps(stripComments(src));
    expect(blocks).toHaveLength(1);
    expect(/\bpending\s*=/.test(blocks[0])).toBe(true);
  });

  it("URL 의 // 는 주석으로 오인하지 않는다", () => {
    expect(stripComments(`const u = "https://a.b";`)).toContain("https://a.b");
  });

  it("ConfirmDialog 가 없으면 빈 배열 — 추출 실패를 통과로 위장하지 않도록", () => {
    expect(dialogProps("<div />")).toHaveLength(0);
  });
});

describe("§0 대상 파일이 실재한다 (경로 오타로 조용히 통과하는 것 방지)", () => {
  for (const { label, rel } of [...IRREVERSIBLE, ...MONEY]) {
    it(`${label} — ${rel}`, () => {
      expect(fs.existsSync(path.join(ROOT, rel)), `경로 없음: ${rel}`).toBe(true);
    });
  }

  it("추출기가 ConfirmDialog 를 실제로 찾는다", () => {
    const src = codeOf(IRREVERSIBLE[0].rel);
    expect(dialogProps(src).length).toBeGreaterThan(0);
  });
});

describe("비가역 동작 — ConfirmDialog 에 pending 이 전달된다", () => {
  for (const { label, rel, state } of IRREVERSIBLE) {
    it(`${label}: pending={${state}}`, () => {
      const blocks = dialogProps(codeOf(rel));
      expect(blocks.length).toBeGreaterThan(0);
      const wired = blocks.filter((b) => /\bpending\s*=/.test(b));
      expect(
        wired.length,
        `${rel} 의 ConfirmDialog ${blocks.length}개 중 pending 전달 ${wired.length}개 — ` +
          `비가역 동작은 확인 버튼이 잠겨야 한다`,
      ).toBe(blocks.length);
      // 상수(true/false)를 박아두면 잠금이 무의미하다 — 상태 변수를 넘겨야 한다.
      for (const b of wired) {
        const v = /\bpending\s*=\s*\{([^}]*)\}/.exec(b)?.[1]?.trim();
        expect(v, `${rel}: pending 값을 읽지 못했다`).toBeTruthy();
        expect(v, `${rel}: pending 에 상수(${v})가 박혀 있다`).not.toMatch(/^(true|false)$/);
        expect(v).toContain(state);
      }
    });
  }
});

describe("금전 화면 — 실패 경로에서도 router.refresh() 로 서버 상태를 다시 읽는다", () => {
  for (const { label, rel } of MONEY) {
    it(`${label}: catch 이후 refresh 도달`, () => {
      const src = codeOf(rel);
      expect(src).toContain("router.refresh()");
      // 성공 분기 안에만 있으면 실패 경로가 옛 화면을 남긴다.
      // catch 블록 뒤(또는 catch 안)에 refresh 가 있어야 한다.
      const lastCatch = src.lastIndexOf("} catch");
      expect(lastCatch, `${rel}: catch 블록이 없다`).toBeGreaterThan(-1);
      const afterCatch = src.slice(lastCatch);
      expect(
        afterCatch.includes("router.refresh()"),
        `${rel}: refresh 가 성공 분기에만 있다 — 실패 시 옛 상태를 보고 재시도하게 된다`,
      ).toBe(true);
    });
  }
});

describe("메시지 발송 — 수신자 수 확정 후에 확인창이 열린다", () => {
  const rel = "events/[eventId]/messages/_components/message-composer.tsx";

  it("setConfirmOpen(true) 가 dryRun 이후(finally)에 있다", () => {
    const src = codeOf(rel);
    const fn = /async function openConfirm\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)?.[1];
    expect(fn, "openConfirm 을 찾지 못했다").toBeTruthy();
    const open = fn!.indexOf("setConfirmOpen(true)");
    const fetchAt = fn!.indexOf("await fetch");
    expect(open, "setConfirmOpen(true) 이 없다").toBeGreaterThan(-1);
    expect(
      open > fetchAt,
      "확인창이 dryRun 보다 먼저 열린다 — 수신자 수를 모르는 채 실발송이 가능해진다",
    ).toBe(true);
  });

  it("수신자 확인 중에는 발송 버튼이 잠긴다", () => {
    expect(codeOf(rel)).toMatch(/disabled=\{[^}]*recipientLoading/);
  });
});

/**
 * 전수 검사 — `ConfirmDialog` **전부**가 `pending` 을 받는다 (2026-07-30, S3).
 *
 * §0~ 위쪽은 "비가역 동작 2곳"만 봤다. S3 에서 나머지 22곳을 정리했으므로 이제 기준선은 **0** 이다.
 * 톱니가 아니다 — 새로 추가하는 확인창도 예외 없이 `pending` 을 넘겨야 한다.
 *
 * ⚠️ 이 검사가 증명하지 않는 것: **버튼이 실제로 잠기는가**. prop 이 전달된다는 것만 본다.
 *    더 나쁜 형태도 이 검사는 못 잡는다 — 확인창이 요청 완료 전에 **닫혀버리면** pending 은
 *    보이지도 않는다(S3 에서 12곳이 그랬다). 실동작은 Playwright 로 봐야 한다.
 *    (구조 검사 ≠ 동작 검사 — `lib/env/runtime.test.ts` 주석과 같은 이유)
 */
describe("§9 전수 — 모든 ConfirmDialog 가 pending 을 받는다", () => {
  const SRC = path.join(__dirname, "..", "..");
  /** 이 파일은 판정식을 합성 입력으로 검증하므로 예외. */
  const SELF = path.join(SRC, "components", "shared", "confirm-dialog-wiring.test.ts");

  function allTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...allTsFiles(full));
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }

  const files = allTsFiles(SRC).filter((f) => f !== SELF);

  it("§9-0 검사 대상을 실제로 수집했고, ConfirmDialog 를 여러 개 찾았다", () => {
    expect(files.length).toBeGreaterThan(100);
    const total = files.reduce((n, f) => n + dialogProps(stripComments(fs.readFileSync(f, "utf8"))).length, 0);
    expect(total, "ConfirmDialog 를 하나도 못 찾았다면 추출기가 깨진 것이다").toBeGreaterThan(20);
  });

  it("pending 을 안 받는 ConfirmDialog 가 없다", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const blocks = dialogProps(stripComments(fs.readFileSync(f, "utf8")));
      const missing = blocks.filter((b) => !/\bpending\s*=/.test(b));
      if (missing.length) offenders.push(`${path.relative(SRC, f)} (${missing.length}/${blocks.length})`);
    }
    expect(
      offenders,
      "응답이 느리면 확인 버튼이 여러 번 눌린다. `useConfirmAction()` 을 쓰면 " +
        "재진입 차단·진행 표시·실패 시 해제가 함께 온다:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });
});
