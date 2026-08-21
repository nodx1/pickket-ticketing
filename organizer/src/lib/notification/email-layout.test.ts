/**
 * 거래 이메일 레이아웃 — **렌더러 단위 검사**.
 *
 * 이메일 HTML 은 브라우저에서 멀쩡해도 메일 클라이언트에서 깨진다. 여기서는 "깨지는
 * 원인이 되는 것을 안 만들었는지" 를 기계로 고정한다. 실제 표시는 실발송으로 따로 본다.
 */
import { describe, expect, it } from "vitest";
import { esc, isSafeUrl, renderTransactionalEmail } from "./email-layout";

const BASE = {
  heading: "예매가 완료되었습니다",
  subheading: "테스트 대회",
  rows: [
    { label: "일시", value: "2026. 8. 20." },
    { label: "장소", value: "포천힐스CC" },
  ],
  paragraphs: ["안내 문단입니다."],
  notice: "주의 문구입니다.",
};

describe("renderTransactionalEmail — 이메일 클라이언트 제약", () => {
  it("🔴 flexbox·grid 를 쓰지 않는다 (상당수 클라이언트가 미지원)", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    expect(html).not.toMatch(/display\s*:\s*(flex|grid)/);
    expect(html).not.toMatch(/(grid-template|flex-direction|justify-content)/);
  });

  it("🔴 <style> 블록·외부 CSS 를 쓰지 않는다 (잘려나간다) — 인라인만", () => {
    const html = renderTransactionalEmail(BASE);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/class=/);
  });

  it("🔴 <html>·<head> 를 붙이지 않는다 — 조각이어야 한다", () => {
    // 광고 경로가 `bodyHtml + footer` 로 뒤에 이어붙인다(compliance.ts). 완전한 문서를
    // 만들면 </html> 뒤에 푸터가 붙는다.
    const html = renderTransactionalEmail(BASE);
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toMatch(/<html/i);
    expect(html).not.toMatch(/<head/i);
    expect(html).not.toMatch(/<body/i);
  });

  it("🔴 이미지를 쓰지 않는다 — 이미지 차단이 기본이라 로고가 안 보인다", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("PICKKET"); // 로고는 글자로
  });

  it("🔴 글자를 담는 태그는 전부 color 를 명시한다 — 다크모드에서 검은 배경 검은 글자 방지", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    const noColor = (html.match(/<(?:p|h1|a|td)\b[^>]*>/g) ?? [])
      // 여백용 빈 셀(`&nbsp;`)과 스타일 없는 구조 셀은 글자를 담지 않는다
      .filter((tag) => /style="[^"]*font-size/.test(tag))
      .filter((tag) => !/color\s*:/.test(tag));
    expect(noColor, `글자색 없는 태그:\n  ${noColor.join("\n  ")}`).toEqual([]);
  });

  it("🔴 배경색을 쓴 곳은 bgcolor 속성도 함께 둔다 (구형 클라이언트가 style 을 버린다)", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    const styleBg = (html.match(/background-color:#[0-9A-Fa-f]{6}/g) ?? []).length;
    const attrBg = (html.match(/bgcolor="#[0-9A-Fa-f]{6}"/g) ?? []).length;
    expect(styleBg).toBeGreaterThan(0);
    expect(attrBg).toBe(styleBg);
  });

  it("표 레이아웃을 쓴다 (div 만으로 조판하지 않는다)", () => {
    expect(renderTransactionalEmail(BASE)).toMatch(/<table\b/);
  });

  /**
   * 🔴 한글은 기본값에서 **어절 한가운데가 잘린다**. 실측으로 "클럽하우/스 대연회장",
   *    "붙여 넣어/주세요" 가 나왔다. 글자를 담는 곳에는 `keep-all` 이 있어야 한다.
   */
  it("🔴 글자를 담는 태그에 word-break:keep-all 이 있다 — 한글 단어가 잘리지 않게", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    const bad = (html.match(/<(?:p|h1|td)\b[^>]*>/g) ?? [])
      .filter((tag) => /style="[^"]*font-size:1[3-9]px/.test(tag)) // 본문 크기 글자만
      .filter((tag) => !/white-space:nowrap/.test(tag)) // 라벨 칸은 안 접힌다
      .filter((tag) => !/keep-all/.test(tag));
    expect(bad, `keep-all 없는 태그:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("URL 만은 반대로 끊는다 — 안 끊으면 카드 밖으로 넘친다", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/" + "a".repeat(200) }]);
    expect(html).toMatch(/word-break:break-all/);
  });

  it("표가 없으면 버튼 위 여백을 더 준다 — 부제에 달라붙지 않게", () => {
    const act = [{ label: "버튼", url: "https://go.pickket.kr/x" }];
    const withRows = renderTransactionalEmail(BASE, act);
    const noRows = renderTransactionalEmail({ heading: "제목", subheading: "부제" }, act);
    expect(withRows).toContain("margin:4px 0 18px");
    expect(noRows).toContain("margin:24px 0 18px");
  });
});

/**
 * 받은편지함 목록의 미리보기 글(프리헤더). 없으면 클라이언트가 본문 앞부분을 긁어가
 * "PICKKET 예매가 완료되었습니다" 처럼 제목과 겹치는 말로 채워진다.
 */
describe("프리헤더", () => {
  it("preview 를 주면 본문 맨 앞에 들어간다", () => {
    const html = renderTransactionalEmail({ ...BASE, preview: "8/20 포천힐스CC · 주중권 2매" });
    expect(html).toContain("8/20 포천힐스CC · 주중권 2매");
    expect(html.indexOf("8/20"), "본문보다 앞에 있어야 클라이언트가 집어간다").toBeLessThan(
      html.indexOf("예매가 완료되었습니다"),
    );
  });

  it("🔴 화면에는 안 보인다 — 숨김을 한 겹으로만 걸지 않는다", () => {
    const html = renderTransactionalEmail({ ...BASE, preview: "숨은 글" });
    const div = html.slice(0, html.indexOf("숨은 글"));
    for (const guard of ["display:none", "max-height:0", "font-size:1px", "opacity:0"]) {
      expect(div, `숨김 장치 누락: ${guard}`).toContain(guard);
    }
  });

  it("preview 가 없으면 숨김 블록을 아예 안 만든다", () => {
    expect(renderTransactionalEmail(BASE)).not.toContain("display:none");
  });

  it("🔴 프리헤더도 이스케이프된다", () => {
    const html = renderTransactionalEmail({ ...BASE, preview: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
  });
});

describe("renderTransactionalEmail — 내용", () => {
  it("제목·부제·표·문단·주의문이 모두 나온다", () => {
    const html = renderTransactionalEmail(BASE);
    for (const s of ["예매가 완료되었습니다", "테스트 대회", "일시", "2026. 8. 20.", "포천힐스CC", "안내 문단입니다.", "주의 문구입니다."]) {
      expect(html, `누락: ${s}`).toContain(s);
    }
  });

  it("🔴 값이 없는 줄은 라벨째로 빠진다 — '장소 -' 같은 빈칸을 보이지 않는다", () => {
    const html = renderTransactionalEmail({
      heading: "제목",
      rows: [
        { label: "일시", value: "2026. 8. 20." },
        { label: "장소", value: null },
        { label: "주문번호", value: "" },
      ],
    });
    expect(html).toContain("일시");
    expect(html).not.toContain("장소");
    expect(html).not.toContain("주문번호");
  });

  /**
   * 🔴 읽는 순서 = 인사 → 정보 → 행동 → 안내.
   *
   * intro 가 버튼 뒤로 밀리면 "위 버튼을 눌러 …" 다음에 "○○님, 결제가 확인되어" 가
   * 나오는 꼴이 된다. 화면으로는 멀쩡해 보여서 눈으로만 보면 놓친다.
   */
  it("🔴 인사(intro)는 표·버튼보다 앞에, 안내(paragraphs)는 뒤에 온다", () => {
    const html = renderTransactionalEmail(
      { heading: "제목", intro: ["인사말입니다"], rows: [{ label: "일시", value: "8월 20일" }], paragraphs: ["안내말입니다"] },
      [{ label: "버튼", url: "https://go.pickket.kr/x" }],
    );
    const at = (s: string) => html.indexOf(s);
    expect(at("인사말입니다")).toBeGreaterThan(-1);
    expect(at("인사말입니다"), "인사가 표보다 뒤에 있다").toBeLessThan(at("8월 20일"));
    expect(at("8월 20일"), "표가 버튼보다 뒤에 있다").toBeLessThan(at("<a href"));
    expect(at("<a href"), "안내가 버튼보다 앞에 있다").toBeLessThan(at("안내말입니다"));
  });

  it("🔴 라벨 칸 폭을 고정한다 — 자동 폭이면 폰에서 긴 장소명이 4~5줄로 흐른다", () => {
    const html = renderTransactionalEmail({ heading: "제목", rows: [{ label: "주문번호", value: "ORD-1" }] });
    // style 을 버리는 클라이언트가 있어 width 속성도 함께 둔다
    expect(html).toMatch(/<td width="\d+"[^>]*style="width:\d+px/);
  });

  /**
   * 🔴 정렬은 가운데다(대표 지시, 2026-08-01). **표만 예외** — 라벨과 값을 둘 다 가운데로
   *    밀면 어느 값이 어느 라벨 것인지 눈으로 못 따라간다. 영수증처럼 양끝으로 벌린다.
   */
  it("🔴 글자는 가운데 정렬한다 — 표만 빼고", () => {
    const html = renderTransactionalEmail(BASE, [{ label: "버튼", url: "https://go.pickket.kr/x" }]);
    const notCentered = (html.match(/<(?:p|h1)\b[^>]*>/g) ?? []).filter((t) => !/text-align:center/.test(t));
    expect(notCentered, `가운데 정렬 안 된 태그:\n  ${notCentered.join("\n  ")}`).toEqual([]);
  });

  it("🔴 표는 라벨 왼쪽 · 값 오른쪽 — 짝을 눈으로 따라갈 수 있게", () => {
    const html = renderTransactionalEmail({ heading: "제목", rows: [{ label: "일시", value: "8월 20일" }] });
    expect(html).toMatch(/<td width="70" align="left"[^>]*text-align:left[^>]*>일시<\/td>/);
    expect(html).toMatch(/<td align="right"[^>]*text-align:right[^>]*>8월 20일<\/td>/);
  });

  it("표가 통째로 비면 표 자체를 만들지 않는다 (빈 테두리만 남지 않게)", () => {
    const html = renderTransactionalEmail({ heading: "제목", rows: [{ label: "장소", value: null }] });
    expect(html).not.toMatch(/border-top:1px solid/);
  });
});

describe("renderTransactionalEmail — 버튼", () => {
  const ACTION = [{ label: "모바일 티켓", url: "https://go.pickket.kr/tickets/TKT-1?t=abc" }];

  it("🔴 누를 수 있는 <a> 로 낸다", () => {
    expect(renderTransactionalEmail(BASE, ACTION)).toMatch(
      /<a href="https:\/\/go\.pickket\.kr\/tickets\/TKT-1\?t=abc"/,
    );
  });

  it("🔴 URL 원문을 함께 남긴다 — 버튼이 안 눌리는 클라이언트가 있다", () => {
    const html = renderTransactionalEmail(BASE, ACTION);
    const occurrences = html.split("/tickets/TKT-1").length - 1;
    expect(occurrences, "href 밖에 URL 이 한 번 더 나와야 한다").toBeGreaterThanOrEqual(2);
  });

  it("버튼 색은 <a> 가 아니라 셀이 갖는다 — Outlook 이 <a> 스타일을 버려도 버튼이 남는다", () => {
    const html = renderTransactionalEmail(BASE, ACTION);
    expect(html).toMatch(/<td[^>]*bgcolor="#6C5CE7"[^>]*>\s*<a href=/);
  });

  it("🔴 http(s) 가 아닌 링크는 href 로 나가지 않는다", () => {
    const html = renderTransactionalEmail(BASE, [
      { label: "위험", url: "javascript:alert(1)" },
      { label: "안전", url: "https://go.pickket.kr/ok" },
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://go.pickket.kr/ok");
  });

  it("버튼이 없으면 링크가 하나도 없다", () => {
    expect(renderTransactionalEmail(BASE)).not.toContain("<a href");
  });
});

describe("이스케이프", () => {
  it("🔴 제목·부제·표값·문단·버튼이름이 전부 이스케이프된다", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = renderTransactionalEmail(
      {
        heading: evil,
        subheading: evil,
        rows: [{ label: evil, value: evil }],
        paragraphs: [evil],
        notice: evil,
      },
      [{ label: evil, url: "https://go.pickket.kr/ok" }],
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert(1)"');
    expect((html.match(/&lt;img/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("🔴 URL 의 따옴표가 속성을 탈출하지 못한다", () => {
    const html = renderTransactionalEmail(BASE, [
      { label: "x", url: 'https://go.pickket.kr/a"onmouseover="alert(1)' },
    ]);
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;onmouseover=");
  });

  it("esc 는 & < > \" 를 바꾼다", () => {
    expect(esc('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });

  it("isSafeUrl 은 http(s) 만 통과시킨다", () => {
    expect(isSafeUrl("https://a.b")).toBe(true);
    expect(isSafeUrl("http://a.b")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,x")).toBe(false);
    expect(isSafeUrl("  https://a.b")).toBe(true);
  });
});
