import type { ReactNode } from "react";

import type { DetailImageView } from "@/lib/public/detail-image";

/**
 * 상세 탭의 **카드 스타일 단일 출처** (2026-07-31 대표 지적).
 *
 * ## 왜 여기 모으는가
 * 같은 상세 이미지인데 탭마다 다르게 보였다 — 장소·주차는 라벨 달린 카드 안에,
 * 행사 소개는 맨몸으로. 원인은 카드 클래스가 `venue-map.tsx` 안에 **인라인으로만**
 * 있었고 `page.tsx` 쪽은 그걸 안 쓴 것이다. 즉 스타일이 복제된 게 아니라
 * **한쪽에만 있었다** — 다른 쪽에 같은 클래스를 또 적어 넣으면 다음에 또 갈라진다.
 * ⟹ 두 곳이 **같은 컴포넌트**를 쓰게 한다.
 */

/**
 * 탭 안의 바깥 카드 — 한 주제(장소 / 행사 소개)를 담는 큰 상자.
 *
 * ## 🔴 폰에서는 테두리를 벗는다 (2026-08-01, 대표 지적)
 * 안내 이미지만 화면 끝까지 넓혔더니 **이미지가 카드 밖으로 삐져나왔다.**
 * 카드는 358px 인데 이미지가 390px 이라 카드 테두리가 이미지 옆에 그대로 남아
 * "액자보다 큰 그림" 이 됐다.
 *
 * ⟹ 폰에서는 **카드도 같이 넓힌다.** 좌우 테두리·모서리·가로 여백을 벗어 이미지와
 *    같은 폭이 되게 한다(한국 예매 사이트의 상세 이미지 관행이기도 하다).
 *    세로 여백과 배경은 남겨 구획은 유지한다. `sm` 이상은 종전 그대로 카드다.
 */
export function DetailSectionCard({ children }: { children: ReactNode }) {
  return (
    <div
      className={
        "space-y-4 rounded-lg border border-border bg-muted p-5 " +
        // 조상 padding 과 무관하게 뷰포트 폭으로 펴진다(음수 마진은 부모가 바뀌면 어긋난다).
        "max-sm:relative max-sm:left-1/2 max-sm:w-screen max-sm:max-w-none max-sm:-translate-x-1/2 " +
        "max-sm:rounded-none max-sm:border-x-0"
      }
    >
      {children}
    </div>
  );
}

/**
 * 안쪽 안내 상자 — 이미지(+선택적 본문)를 담는다.
 *
 * 🔴 라벨은 **텍스트로 남긴다**. 이미지 안에 제목이 있어도 검색엔진과 낭독기는 못 읽는다
 *    (`venue-map.tsx` 가 원래 그렇게 만들어진 이유). 라벨이 본문 제목과 겹치는 자리
 *    (행사 소개)에서는 `label` 을 비우고 상자만 쓴다 — 같은 말이 두 번 나오면 오히려 방해다.
 */
export function DetailImageBox({
  label,
  icon,
  items,
  children,
}: {
  label?: string;
  icon?: ReactNode;
  items: DetailImageView[];
  children?: ReactNode;
}) {
  if (items.length === 0 && !children) return null;

  return (
    // 폰에서는 안쪽 상자도 좌우 테두리를 벗는다 — 바깥 카드가 화면 폭인데 여기만
    // 액자가 남으면 다시 어긋나 보인다. 가로 여백은 글자 때문에 남긴다.
    <div className="rounded-lg border border-border bg-background/40 p-4 max-sm:rounded-none max-sm:border-x-0 max-sm:bg-transparent">
      {label ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          {label}
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className={label ? "mt-2" : undefined}>
          <DetailImages items={items} />
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * 이벤트 소개 상세 이미지 — 세로로 이어 붙인다(한국 예매 사이트 관행).
 *
 * 서버 컴포넌트다. 클릭·확대가 없으므로 클라이언트 JS 가 필요 없고,
 * 그래서 첫 화면에서 바로 보인다(소개는 스크롤 상단이라 중요하다).
 *
 * 🔴 `w-full h-auto` — 폭만 맞추고 높이는 원본 비율대로 둔다.
 *    높이를 고정하거나 object-cover 를 쓰면 **안내문 글자가 잘린다**.
 *    갤러리에서 이미 같은 이유로 cover 를 걷어냈다.
 *
 * ## 🔴 폰에서 넓히되, 글자와 **같은 선**에 세운다 (2026-08-01)
 *
 * 세 번 고쳤다. 남기는 이유는 되돌리기 쉬운 종류의 결정이기 때문이다.
 *
 *   ① 이미지에만 풀블리드    → 카드(358)보다 이미지(390)가 커져 **액자 밖으로 삐져나옴**
 *   ② 카드까지 풀블리드      → 폭은 맞았지만 **화면 끝에 딱 붙어** 이미지 안의 둥근
 *                              모서리가 잘린 것처럼 보이고, 20px 선에 있는 제목·설명문과
 *                              왼쪽 가장자리가 어긋남
 *   ③ **지금** — 카드는 화면 폭까지 펴되 가로 여백(20px)은 남기고, 이미지는 안쪽 상자
 *      여백만 되돌려 **제목과 같은 20px 선**에 선다(350px).
 *
 * ## 왜 이걸 건드렸나
 *
 * 대회 개요·티켓 가격·환불 규정·입장 안내가 **전부 이 이미지 안**에 있는데,
 * 아이폰(390px)에서 **282px** 로 나오고 있었다 — 원본 2078px 대비 **0.14배**.
 * 중첩된 카드 padding 이 폭을 갉아먹은 것이다(실측):
 *
 *     390  → 358   페이지 px-4   (-32)
 *          → 316   바깥 카드 p-5 (-40)
 *          → 282   안쪽 상자 p-4 (-32)
 *
 * 지금 구조에서는 **바깥 카드가 화면 폭까지 펴고**(`DetailSectionCard`), 이 컴포넌트는
 * **안쪽 상자 여백만** 되돌린다. 그러면 카드 여백(20px) 선에 서고, 그 선이 곧 제목·설명문이
 * 서는 선이다. 원래 282 → **350px (+24%)**.
 *
 * ⚠️ 되돌리는 값은 **안쪽 상자 여백과 같아야 한다**(`p-4` = `-mx-4`). 더 되돌리면 화면 끝에
 *    붙고(②의 문제), 덜 되돌리면 글자보다 안쪽으로 들어간다. 이 산술은 테스트가 계산한다
 *    (`lib/public/detail-image-layout.test.ts`).
 *
 * ⚠️ **규칙은 "이미지는 자기 상자의 가장자리까지" 다.** 그 상자가 어디 놓이느냐에 따라
 *    최종 위치가 달라진다 — 의도된 차이다(전 탭 실측):
 *
 *      행사 소개 · 장소·주차   상자가 `DetailSectionCard` 안 → 이미지 **20px** (제목과 같은 선)
 *      문의                    상자만 단독으로 씀            → 이미지 **16px** (페이지 여백 선)
 *
 *    문의 탭은 섹션 카드를 안 쓰므로 이미지가 페이지 격자(16px)에 선다. 라벨(32px)보다
 *    바깥이지만 페이지의 다른 요소와는 같은 선이라 어색하지 않다. **버그로 보고 고치지 말 것** —
 *    맞추려면 그 탭도 `DetailSectionCard` 로 감싸야 하고, 그건 탭의 모양을 바꾸는 별건이다.
 *
 * ⚠️ 근본 해법은 아니다. 이미지 속 글자는 확대·복사·검색·번역·스크린리더가 전부 안 되고,
 *    가격이 이미지와 티켓 카드 **두 곳**에 있어 주최자가 값을 바꾸면 갈라진다.
 *    가격표·일정은 HTML 로 옮겨야 한다(별건).
 */
export function DetailImages({ items }: { items: DetailImageView[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-3 max-sm:-mx-4">
      {items.map((item, i) => (
        /* eslint-disable-next-line @next/next/no-img-element -- 외부/로컬 혼용 URL, next/image remotePatterns 불필요 */
        <img
          key={`${item.url}-${i}`}
          src={item.url}
          alt={item.alt}
          /* 첫 장은 화면에 바로 들어오므로 지연 로딩하지 않는다(LCP). */
          loading={i === 0 ? "eager" : "lazy"}
          className="h-auto w-full rounded-lg"
        />
      ))}
    </div>
  );
}
