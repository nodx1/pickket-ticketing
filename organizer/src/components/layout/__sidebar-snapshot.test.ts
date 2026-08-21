/**
 * ⚠️ 검수용 스냅샷 생성기 — 어서션 최소. 사이드바를 **실제 컴포넌트로 SSR** 해 HTML 로 떨군다.
 *
 * 목적: 기능 토글 조합별로 사람이 눈으로 확인할 화면을 만든다. 로그인이 v2 의존이라
 *       대시보드 진입이 막힌 상황에서, 문자열 검색 대신 실제 렌더 결과를 보기 위한 도구다.
 * `SIDEBAR_SNAPSHOT_OUT` 이 있을 때만 동작(평시 skip).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/navigation", () => ({ usePathname: () => "/events/EV1/dashboard" }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("@/lib/stores/uiPreferencesStore", () => ({
  useUIPreferences: () => ({
    collapsedGroups: new Set<string>(["comms", "advanced"]),
    toggleGroup: () => {},
    trackUsage: () => {},
    itemUsageCount: {},
    hydrate: () => {},
  }),
}));

const OUT = process.env.SIDEBAR_SNAPSHOT_OUT;

const CASES = [
  { name: "① 토글 전부 OFF", gates: { enabledFeatures: [] as string[], hasLotteryPhase: false, raffleEnabled: false } },
  { name: "② 초대권(ticket_issuance)만 ON", gates: { enabledFeatures: ["ticket_issuance"], hasLotteryPhase: false, raffleEnabled: false } },
  { name: "③ 토글 전부 ON", gates: { enabledFeatures: ["group_booking", "participants", "facilities", "ticket_issuance"], hasLotteryPhase: true, raffleEnabled: true } },
];

describe.skipIf(!OUT)("사이드바 스냅샷 생성", () => {
  it("토글 조합별 HTML 출력", async () => {
    const { EventSidebar } = await import("./event-sidebar");
    // 빌드된 CSS(Tailwind 유틸 포함)를 우선 사용 — 원본 globals.css 만 넣으면 유틸이 없어
    // 접힘(max-h-0)·레이아웃이 전부 무시된 화면이 나온다.
    const cssCandidates = [
      ".next/dev/static/chunks/src_app_globals_css_1igg3k2._.single.css",
      "src/app/globals.css",
    ];
    const cssPath = cssCandidates.map((c) => path.join(process.cwd(), c)).find((c) => fs.existsSync(c))!;
    const css = fs.readFileSync(cssPath, "utf8");

    const panels = CASES.map((c) => {
      const html = renderToStaticMarkup(
        createElement(EventSidebar, {
          event: {
            id: "EV1",
            title: "BC카드·한경 제48회 KLPGA 챔피언십",
            slug: "klpga-2026",
            status: "live" as never,
            ...c.gates,
          },
        }),
      );
      return `<section><h3 class="case-title">${c.name}</h3>${html}</section>`;
    }).join("\n");

    const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>${css}</style>
<style>
  body{background:#FAFBFF;padding:24px;font-family:Pretendard,-apple-system,sans-serif;margin:0}
  .grid{display:flex;gap:20px;align-items:flex-start}
  .case-title{font:700 13px/1.4 sans-serif;color:#6C5CE7;margin:0 0 10px}
  section{background:#fff;padding:12px;border-radius:12px;border:1px solid rgba(0,0,0,.08)}
</style></head><body><div class="grid">${panels}</div></body></html>`;

    fs.mkdirSync(OUT!, { recursive: true });
    fs.writeFileSync(path.join(OUT!, "sidebar.html"), doc);
    expect(doc).toContain("체크인");
  });
});
