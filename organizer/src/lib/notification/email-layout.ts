/**
 * 거래 이메일 레이아웃 — **순수 모듈**(서버 의존 0, 문자열만 만든다).
 *
 * ── 왜 따로 뺐나 ──
 * 종전 이메일 본문은 **알림톡 승인본을 그대로 재활용**했다. 알림톡은 한 글자도 못 바꾸는
 * 카카오 승인 문안이라(`alimtalk-templates.ts`) `▶`·`※` 기호와 줄바꿈이 그대로 메일에
 * 실렸고, `white-space:pre-line` 하나에 기대다 보니 그 속성을 무시하는 클라이언트에서는
 * **한 문단으로 뭉쳐** 보였다. 이메일은 카카오 승인과 무관하므로 전용 본문을 만든다.
 *
 * ── 이메일 HTML 은 웹이 아니다 ──
 * ① flexbox·grid 미지원 클라이언트가 많다 → `<table>` 레이아웃
 * ② `<style>`·외부 CSS 가 잘려나간다 → **인라인 스타일만**
 * ③ 이미지 차단이 기본 → 로고도 **텍스트**로. 이미지 없이 완성되게 만든다
 * ④ 다크모드가 배경만 뒤집는 클라이언트가 있다 → 배경·글자색을 **둘 다** 명시.
 *    한쪽만 쓰면 검은 배경에 검은 글자가 된다
 * ⑤ 🔴 버튼이 안 눌리는 클라이언트가 있다 → `<a>` 와 **함께 URL 원문**을 남긴다
 *
 * ⚠️ **본문 조각(fragment)만 만든다.** `<html>`/`<head>` 를 붙이면 안 된다 —
 *    광고 경로가 `bodyHtml + footer` 로 뒤에 이어붙이므로(`compliance.ts:242`)
 *    `</html>` 뒤에 푸터가 붙는 꼴이 된다. `<meta color-scheme>` 를 못 쓰는 이유도 이것이라,
 *    다크모드는 ④번(색 양쪽 명시)으로 감당한다.
 */

/** HTML 이스케이프 — 본문 변수(행사명·장소 등)가 그대로 렌더되지 않게 한다. */
export function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 링크 스킴 제한 — `http(s)` 만 `href` 로 내보낸다.
 *
 * 지금 URL 은 전부 우리가 만든 것이지만(`buildTicketLinkUrl` 등), 호출부가 하나만 바뀌어도
 * `javascript:` 가 메일에 실릴 수 있다. 막는 비용이 0 이라 막아둔다.
 */
export function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailContent {
  /** 큰 제목 — "예매가 완료되었습니다" */
  heading: string;
  /** 부제 — 보통 행사명 */
  subheading?: string;
  /** 라벨/값 표. 값이 비면(`null`·빈 문자열) **그 줄을 통째로 뺀다** */
  rows?: Array<{ label: string; value?: string | null }>;
  /** 표보다 **위**에 오는 인사·요약 문단. 읽는 순서가 인사 → 정보 → 행동이 되게 한다 */
  intro?: string[];
  /** 버튼 **아래** 오는 안내 문단 */
  paragraphs?: string[];
  /** 주의 문구 — 옅은 배경 박스로 강조 */
  notice?: string;
  /** 받은편지함 목록에 제목과 함께 보이는 미리보기 글. 본문에는 안 보인다 */
  preview?: string;
}

const BRAND = "#6C5CE7";
const INK = "#1A1D2E";
// 대비 실측: #6B7280 은 페이지 배경(#F4F5F7) 위에서 4.43 으로 **AA(4.5) 미달**이었다.
// 푸터가 그 배경 위에 올라가므로 한 단계 어둡게 잡는다(흰 배경 5.72 · 페이지 배경 5.24).
const MUTED = "#5F6773";
const LINE = "#E9EAF0";
const PAGE_BG = "#F4F5F7";
const CARD_BG = "#FFFFFF";

const FONT =
  "-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";

/**
 * 🔴 한글 줄바꿈 — `word-break:keep-all` 이 없으면 **단어 한가운데가 잘린다.**
 *    영문은 공백에서 끊지만 한글은 기본값(`normal`)에서 어절 안이든 밖이든 아무 데서나
 *    끊는다. 실측: "포천힐스컨트리클럽 클럽하우/스 대연회장", "붙여 넣어/주세요".
 *    글자를 담는 곳에는 전부 붙인다(URL 은 예외 — 거긴 반대로 끊어야 한다).
 */
const WRAP = "word-break:keep-all;overflow-wrap:break-word";

/**
 * 버튼 — `<a>` 를 셀 안에 넣는다.
 *
 * Outlook 계열은 `<a>` 의 `padding`·`background` 를 무시하는 일이 있어, 색을 **셀(`bgcolor`)**
 * 이 갖고 `<a>` 는 글자만 담당하게 한다. `<a>` 스타일이 통째로 날아가도 색 있는 버튼은 남는다.
 */
function actionButton(a: EmailAction): string {
  return (
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" ` +
    `style="margin:0 auto 10px">` +
    `<tr><td align="center" bgcolor="${BRAND}" style="background-color:${BRAND};border-radius:100px">` +
    `<a href="${esc(a.url)}" style="display:inline-block;padding:14px 34px;font-family:${FONT};` +
    `font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none">${esc(a.label)}</a>` +
    `</td></tr></table>`
  );
}

/** 본문 문단 — intro·paragraphs 가 같은 모양이어야 하므로 한 곳에서 만든다. */
function para(lines: string[]): string {
  return lines
    .map(
      (t) =>
        `<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.7;` +
        `color:${INK};text-align:center;${WRAP}">${esc(t)}</p>`,
    )
    .join("");
}

function infoRows(rows: NonNullable<EmailContent["rows"]>): string {
  const cells = rows
    .filter((r) => Boolean(r.value))
    .map(
      (r) =>
        `<tr>` +
        // ⚠️ 표만은 글자를 가운데로 밀지 않는다 — 라벨과 값이 서로 어느 줄에 붙는지
        //    알 수 없게 된다. **라벨 왼쪽 · 값 오른쪽**(영수증 양끝 정렬)이라야
        //    가운데 정렬 레이아웃 안에서도 짝이 눈으로 읽힌다.
        // 라벨 폭을 고정한다 — 자동 폭이면 라벨이 값의 자리를 먹어, 폰에서 긴 장소명이
        // 4~5줄로 흐른다(실측). 가장 긴 라벨이 '주문번호'(4글자)라 70px 이면 충분하다.
        `<td width="70" align="left" style="width:70px;padding:9px 0;font-family:${FONT};` +
        `font-size:14px;color:${MUTED};white-space:nowrap;vertical-align:top;text-align:left">` +
        `${esc(r.label)}</td>` +
        `<td align="right" style="padding:9px 0 9px 14px;font-family:${FONT};font-size:14px;` +
        `font-weight:600;color:${INK};vertical-align:top;text-align:right;${WRAP}">` +
        `${esc(r.value as string)}</td>` +
        `</tr>`,
    )
    .join("");
  if (!cells) return "";
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};margin:22px 0">` +
    cells +
    `</table>`
  );
}

/**
 * 거래 이메일 본문 HTML.
 *
 * 🔴 `actions` 가 있으면 **버튼 + URL 원문**을 함께 낸다. URL 원문을 빼면 버튼이 안 눌리는
 *    클라이언트에서 구매자가 티켓에 도달할 길이 사라진다(2026-08-01 실사고와 같은 결과).
 */
export function renderTransactionalEmail(content: EmailContent, actions: EmailAction[] = []): string {
  const safe = actions.filter((a) => isSafeUrl(a.url));
  const hasRows = (content.rows ?? []).some((r) => Boolean(r.value));

  /**
   * 받은편지함 목록의 미리보기 글. 안 넣으면 클라이언트가 본문 앞을 긁어가 **"PICKKET 예매가
   * 완료되었습니다"** 처럼 제목과 겹치는 말로 채워진다. 제목에 없는 정보(일시·장소)를 준다.
   *
   * ⚠️ 화면에는 보이면 안 되므로 `display:none` 만으로는 부족하다(무시하는 클라이언트가 있다).
   *    높이 0 + 글자 1px + 배경과 같은 색까지 겹쳐서 막는다.
   */
  const preheader = content.preview
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;` +
      `line-height:1px;color:${PAGE_BG};opacity:0">${esc(content.preview)}</div>`
    : "";

  const head =
    `<tr><td align="center" style="padding:30px 30px 0;text-align:center">` +
    `<div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.1em;` +
    `color:${BRAND}">PICKKET</div>` +
    `<h1 style="margin:18px 0 0;font-family:${FONT};font-size:21px;line-height:1.4;` +
    `font-weight:700;color:${INK};text-align:center;${WRAP}">${esc(content.heading)}</h1>` +
    (content.subheading
      ? `<p style="margin:8px 0 0;font-family:${FONT};font-size:15px;line-height:1.5;` +
        `color:${INK};text-align:center;${WRAP}">${esc(content.subheading)}</p>`
      : "") +
    `</td></tr>`;

  const body =
    `<tr><td align="center" style="padding:0 30px;text-align:center">` +
    // 인사는 표보다 위 — 버튼 뒤에 나오면 "위 버튼을 눌러" 다음에 인사가 오는 꼴이 된다.
    (content.intro?.length ? `<div style="margin-top:16px">${para(content.intro)}</div>` : "") +
    infoRows(content.rows ?? []) +
    // 표가 없으면(체크인 메일) 표의 위 여백이 없어 버튼이 부제에 달라붙는다 — 그때만 띄운다.
    (safe.length
      ? `<div style="margin:${hasRows ? "4px" : "24px"} 0 18px">${safe.map(actionButton).join("")}</div>`
      : "") +
    para(content.paragraphs ?? []) +
    (content.notice
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `bgcolor="#FBF7EE" style="background-color:#FBF7EE;border-radius:10px;margin:6px 0 4px">` +
        `<tr><td style="padding:13px 15px;font-family:${FONT};font-size:13px;line-height:1.6;` +
        `color:#7A5D12;text-align:center;${WRAP}">${esc(content.notice)}</td></tr></table>`
      : "") +
    // 🔴 버튼이 안 눌리는 클라이언트를 위해 URL 원문을 남긴다. **빼지 말 것** — 빼면 그
    //    클라이언트에서 구매자가 티켓에 도달할 길이 사라진다.
    //    ⚠️ 위치는 맨 아래다. 버튼 바로 밑에 두면 정체불명의 긴 토큰 문자열이 본문 한가운데를
    //       차지해, 정작 읽어야 할 안내와 주의문을 밀어낸다(렌더해서 확인).
    (safe.length
      ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;` +
        `color:${MUTED};text-align:center;${WRAP}">버튼이 안 열리면 아래 주소로 접속해 주세요.</p>` +
        safe
          .map(
            (a) =>
              `<p style="margin:4px 0 14px;font-family:${FONT};font-size:12px;line-height:1.6;` +
              `color:${MUTED};text-align:center;word-break:break-all">${esc(a.url)}</p>`,
          )
          .join("")
      : "") +
    `<div style="height:26px;line-height:26px;font-size:0">&nbsp;</div>` +
    `</td></tr>`;

  // ⚠️ 푸터에 `<a>` 를 쓰지 않는다 — 버튼이 없는 메일(티켓번호 미전달)에는 링크가 하나도
  //    없어야 한다는 것이 회귀 테스트의 판정 기준이다. 주소는 글자로 충분히 읽힌다.
  const foot =
    `<div style="max-width:560px;margin:16px auto 0;padding:0 6px;font-family:${FONT};` +
    `font-size:12px;line-height:1.7;color:${MUTED};text-align:center">` +
    `발신 전용 메일입니다. 문의 support@pickket.kr` +
    `</div>`;

  // ⚠️ 바깥 여백도 `<table>` 셀의 padding 으로 준다. 배경 있는 `<div>` 로 감싸면 `bgcolor`
  //    속성을 못 달아(div 는 지원 안 함) style 을 버리는 클라이언트에서 그 배경만 사라진다.
  return (
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG}">` +
    `<tr><td align="center" style="padding:26px 14px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="${CARD_BG}" style="max-width:560px;background-color:${CARD_BG};border-radius:16px;` +
    `border:1px solid ${LINE}">` +
    head +
    body +
    `</table>` +
    foot +
    `</td></tr></table>`
  );
}
