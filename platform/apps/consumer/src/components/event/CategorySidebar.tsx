"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Music,
  Drama,
  Trophy,
  Music2,
  Palette,
  PartyPopper,
  Landmark,
  ChevronRight,
} from "lucide-react";
import { CATEGORIES, SUB_CATEGORIES, type CategorySlug } from "@pickket/lib";

/* ── icon map ──────────────────────────────────────────────────────── */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Music,
  Drama,
  Trophy,
  Music2,
  Palette,
  PartyPopper,
};

/* ── featured tags per subcategory ─────────────────────────────────── */
const FEATURED: Record<string, string[]> = {
  "K-POP": ["보이그룹", "걸그룹", "솔로", "아이돌", "팬미팅", "컴백 쇼케이스"],
  "록/밴드": [
    "국내 밴드",
    "해외 밴드",
    "인디 록",
    "라이브 공연",
    "페스티벌",
    "어쿠스틱",
  ],
  "힙합/R&B": [
    "힙합 콘서트",
    "R&B 라이브",
    "래퍼",
    "싱어송라이터",
    "사이퍼",
    "쇼케이스",
  ],
  인디: [
    "인디 밴드",
    "싱어송라이터",
    "어쿠스틱",
    "소극장",
    "라이브클럽",
    "버스킹",
  ],
  트로트: [
    "트로트 콘서트",
    "전국투어",
    "팬미팅",
    "디너쇼",
    "페스티벌",
    "신인 쇼케이스",
  ],
  해외아티스트: ["월드투어", "내한공연", "팝", "록", "R&B/소울", "일렉트로닉"],
  오리지널: [
    "브로드웨이",
    "웨스트엔드",
    "대극장",
    "장기공연",
    "가족뮤지컬",
    "명작",
  ],
  라이선스: ["한국어 공연", "대극장", "인기작", "앙코르", "리바이벌", "신작"],
  창작: ["한국 창작", "초연", "재연", "소극장", "대극장", "신작"],
  연극: ["드라마", "코미디", "스릴러", "클래식", "소극장", "실험극"],
  오페라: [
    "이탈리아 오페라",
    "독일 오페라",
    "한국 오페라",
    "갈라 콘서트",
    "오페라 하이라이트",
    "야외 오페라",
  ],
  야구: [
    "KBO 리그",
    "시범경기",
    "플레이오프",
    "올스타전",
    "주말 경기",
    "주중 경기",
  ],
  축구: [
    "K리그",
    "FA컵",
    "국가대표",
    "아시아 챔피언스리그",
    "주말 경기",
    "더비 매치",
  ],
  농구: [
    "KBL 리그",
    "플레이오프",
    "올스타전",
    "정규시즌",
    "주말 경기",
    "챔피언결정전",
  ],
  배구: ["V리그", "남자부", "여자부", "플레이오프", "올스타전", "챔피언결정전"],
  e스포츠: [
    "LoL",
    "발로란트",
    "오버워치",
    "리그 경기",
    "결승전",
    "월드 챔피언십",
  ],
  격투기: [
    "종합격투기",
    "복싱",
    "국제 대회",
    "타이틀매치",
    "국내 대회",
    "격투 페스티벌",
  ],
  오케스트라: [
    "정기 연주회",
    "특별 연주회",
    "초청 지휘자",
    "시즌 개막",
    "교향곡",
    "협주곡",
  ],
  독주회: ["피아노", "바이올린", "첼로", "성악", "리사이틀", "초청 연주"],
  앙상블: [
    "현악 앙상블",
    "관악 앙상블",
    "실내악",
    "콰르텟",
    "트리오",
    "특별 편성",
  ],
  합창: [
    "정기 공연",
    "합창제",
    "크리스마스 공연",
    "종교음악",
    "합창 페스티벌",
    "초청 공연",
  ],
  미술: ["특별전", "기획전", "상설전", "현대미술", "인상파", "팝아트"],
  사진: [
    "사진전",
    "보도사진",
    "예술사진",
    "자연사진",
    "초상사진",
    "디지털아트",
  ],
  디자인: [
    "디자인위크",
    "산업디자인",
    "그래픽디자인",
    "타이포그래피",
    "인터랙티브",
    "공간디자인",
  ],
  체험전: [
    "몰입형 전시",
    "인터랙티브",
    "미디어아트",
    "VR/AR",
    "피규어/토이",
    "과학체험",
  ],
  팝업: [
    "브랜드 팝업",
    "아트 팝업",
    "캐릭터",
    "패션",
    "라이프스타일",
    "한정판",
  ],
  음악축제: [
    "록 페스티벌",
    "재즈 페스티벌",
    "EDM",
    "힙합 페스티벌",
    "야외 공연",
    "복합 페스티벌",
  ],
  문화축제: [
    "영화제",
    "불꽃축제",
    "거리축제",
    "전통축제",
    "야간축제",
    "예술축제",
  ],
  푸드: [
    "카페/커피",
    "맥주/와인",
    "지역 맛집",
    "푸드마켓",
    "쿠킹클래스",
    "미식 페스티벌",
  ],
  계절행사: [
    "봄 축제",
    "여름 축제",
    "가을 축제",
    "겨울 축제",
    "시즌 한정",
    "야외 행사",
  ],
};

/* ── sidebar items (교육/강연·시민참여는 공공예약 서브로 이동) ──────── */
const PUBLIC_SUB_SLUGS = new Set<string>(["education", "civic"]);
const SIDEBAR_ITEMS = CATEGORIES.filter(
  (c) => !PUBLIC_SUB_SLUGS.has(c.slug),
).map((c) => ({
  slug: c.slug as CategorySlug,
  label: c.label,
  labelEn: c.labelEn,
  icon: c.icon,
  color: c.color,
}));

/* 공공예약 서브카테고리 */
const PUBLIC_SUB_CATEGORIES = [
  "지역축제",
  "박람회/엑스포",
  "공공시설",
  "교육/강연",
  "시민참여",
  "체육행사",
];
const PUBLIC_FEATURED: Record<string, string[]> = {
  지역축제: [
    "봄꽃축제",
    "여름물축제",
    "가을단풍축제",
    "겨울빛축제",
    "전통문화축제",
    "지역특산품축제",
    "불꽃축제",
    "등불축제",
    "해변축제",
    "산림축제",
  ],
  "박람회/엑스포": [
    "산업박람회",
    "관광박람회",
    "교육박람회",
    "취업박람회",
    "농식품박람회",
    "IT/기술엑스포",
    "건축박람회",
    "뷰티/패션박람회",
    "유아/아동박람회",
    "반려동물박람회",
  ],
  공공시설: [
    "문화센터",
    "시민회관",
    "도서관행사",
    "체육관대관",
    "공원행사",
    "야외무대",
    "청소년수련관",
    "복지관프로그램",
    "미술관특별전",
    "박물관기획전",
  ],
  "교육/강연": SUB_CATEGORIES["education"],
  시민참여: SUB_CATEGORIES["civic"],
  체육행사: [
    "시민마라톤",
    "걷기대회",
    "생활체육대회",
    "구민체육대회",
    "수영대회",
    "자전거대회",
    "등산대회",
    "어린이체육행사",
  ],
};

/* Pages where the sidebar should be hidden */
const HIDDEN_PATHS = ["/auth", "/onboarding"];

/* Non-default locales for prefix stripping */
const NON_DEFAULT_LOCALES = ["en", "ja", "zh-CN", "fr"];

export default function CategorySidebar() {
  const t = useTranslations("event.categorySidebar");
  const pathname = usePathname();
  const [activeMenu, setActiveMenu] = useState<CategorySlug | "public" | null>(
    null,
  );
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const resetMenu = useCallback(() => {
    setActiveMenu(null);
    setActiveSub(null);
  }, []);

  /* Strip locale prefix for consistent route matching across all locales */
  const segments = pathname.split("/");
  const hasLocalePrefix = NON_DEFAULT_LOCALES.includes(segments[1]);
  const canonicalPath = hasLocalePrefix
    ? "/" + segments.slice(2).join("/") || "/"
    : pathname;

  /* Hide sidebar on full-screen pages */
  const isHidden = HIDDEN_PATHS.some((p) => canonicalPath.startsWith(p));

  /* close mega menu on outside click */
  useEffect(() => {
    if (isHidden) return;
    const handler = (e: MouseEvent) => {
      if (
        sidebarRef.current &&
        !sidebarRef.current.contains(e.target as Node)
      ) {
        setActiveMenu(null);
        setActiveSub(null);
      }
    };
    if (activeMenu) {
      document.addEventListener("mousedown", handler);
    }
    return () => document.removeEventListener("mousedown", handler);
  }, [activeMenu, isHidden]);

  /* close on route change */
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      resetMenu();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pathname, resetMenu]);

  if (isHidden) return null;

  const handleToggle = (slug: CategorySlug | "public") => {
    if (activeMenu === slug) {
      setActiveMenu(null);
      setActiveSub(null);
    } else {
      setActiveMenu(slug);
      if (slug === "public") {
        setActiveSub(PUBLIC_SUB_CATEGORIES[0]);
      } else {
        const subs = SUB_CATEGORIES[slug];
        setActiveSub(subs?.[0] ?? null);
      }
    }
  };

  const isPublicMenu = activeMenu === "public";
  const currentSubs = isPublicMenu
    ? PUBLIC_SUB_CATEGORIES
    : activeMenu
      ? SUB_CATEGORIES[activeMenu]
      : [];
  const currentFeatured = activeSub
    ? isPublicMenu
      ? (PUBLIC_FEATURED[activeSub] ?? [])
      : (FEATURED[activeSub] ?? [])
    : [];
  const activeCategory = isPublicMenu
    ? { label: t("publicSector"), labelEn: "Public Sector" }
    : SIDEBAR_ITEMS.find((i) => i.slug === activeMenu);

  return (
    <div ref={sidebarRef} className="hidden lg:block">
      {/* ── Floating sidebar card ─────────────────────────────── */}
      <div
        style={{ left: 128 }}
        className="fixed top-1/2 -translate-y-1/2 z-40 w-[68px] bg-card border border-border rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] py-3 flex flex-col items-center gap-0.5"
      >
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = ICON_MAP[item.icon];
          const isActive =
            activeMenu === item.slug ||
            pathname.startsWith(`/category/${item.slug}`);

          return (
            <button
              key={item.slug}
              type="button"
              onClick={() => handleToggle(item.slug)}
              className={`relative flex flex-col items-center justify-center gap-1 w-[60px] py-2.5 rounded-xl transition-all duration-150 group ${
                isActive
                  ? "text-primary bg-secondary"
                  : "text-muted-foreground hover:text-primary hover:bg-surface-dim"
              }`}
            >
              <span
                className={`flex items-center justify-center h-9 w-9 rounded-xl transition-all duration-150 ${
                  isActive
                    ? "bg-primary text-white shadow-md"
                    : "bg-muted text-inherit group-hover:bg-white group-hover:shadow-sm"
                }`}
              >
                {Icon && <Icon className="h-[18px] w-[18px]" />}
              </span>
              <span className="text-2xs font-medium leading-tight text-center">
                {item.label}
              </span>
            </button>
          );
        })}

        {/* Divider */}
        <div className="w-10 h-px bg-border my-1.5" />

        {/* 공공예약 (교육/강연 · 시민참여를 메가메뉴로) */}
        <button
          type="button"
          onClick={() => handleToggle("public")}
          className={`relative flex flex-col items-center justify-center gap-1 w-[60px] py-2.5 rounded-xl transition-all duration-150 group ${
            activeMenu === "public" ||
            pathname.includes("/government") ||
            pathname.includes("/category/education") ||
            pathname.includes("/category/civic")
              ? "text-primary bg-secondary"
              : "text-muted-foreground hover:text-primary hover:bg-surface-dim"
          }`}
        >
          <span
            className={`flex items-center justify-center h-9 w-9 rounded-xl transition-all duration-150 ${
              activeMenu === "public" || pathname.includes("/government")
                ? "bg-primary text-white shadow-md"
                : "bg-muted text-inherit group-hover:bg-white group-hover:shadow-sm"
            }`}
          >
            <Landmark className="h-[18px] w-[18px]" />
          </span>
          <span className="text-2xs font-medium">{t("publicSector")}</span>
        </button>
      </div>

      {/* ── Mega menu floating panel ──────────────────────────── */}
      {activeMenu && (
        <div
          style={{ left: 208 }}
          className="fixed top-1/2 -translate-y-1/2 z-50 animate-megaMenuIn"
        >
          <div className="bg-card rounded-2xl shadow-[0_16px_64px_rgba(0,0,0,0.4)] border border-border flex overflow-hidden w-[520px] max-h-[calc(100vh_-_120px)]">
            {/* Left column — subcategories */}
            <div className="w-[190px] border-r border-border flex flex-col py-5">
              {/* Category header */}
              <div className="px-5 pb-4">
                <h3 className="text-base font-bold text-foreground">
                  {activeCategory?.label}
                </h3>
                <p className="text-xs-plus text-muted-foreground mt-0.5">
                  {activeCategory?.labelEn}
                </p>
              </div>

              {/* Subcategory list */}
              <div className="flex-1 px-3 space-y-0.5 overflow-y-auto">
                {currentSubs.map((sub) => {
                  const isSubActive = activeSub === sub;
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => setActiveSub(sub)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm-minus transition-all ${
                        isSubActive
                          ? "bg-primary text-white font-semibold"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <span>{sub}</span>
                      <ChevronRight
                        className={`h-3.5 w-3.5 ${
                          isSubActive
                            ? "text-white/70"
                            : "text-muted-foreground"
                        }`}
                      />
                    </button>
                  );
                })}
              </div>

              {/* View all link */}
              <div className="px-4 pt-4 mt-2 border-t border-border">
                <Link
                  href={
                    isPublicMenu ? "/government" : `/category/${activeMenu}`
                  }
                  className="flex items-center gap-1 text-sm-minus font-semibold text-primary hover:underline"
                >
                  {t("viewAll")}
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>

            {/* Right column — featured items */}
            <div className="flex-1 flex flex-col py-5">
              <div className="px-5 pb-3">
                <h4 className="text-xs-plus font-semibold text-muted-foreground uppercase tracking-wider">
                  Featured
                </h4>
              </div>
              <div className="flex-1 px-5 overflow-y-auto">
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {currentFeatured.map((name) => (
                    <Link
                      key={name}
                      href={`/events?q=${encodeURIComponent(name)}`}
                      className="py-2 text-sm-minus text-foreground hover:text-primary transition-colors"
                    >
                      {name}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
