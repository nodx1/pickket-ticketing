"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

/* ── Shared metric card ──────────────────────────────────────────── */
function StatBlock({
  value,
  label,
  sub,
  accent,
}: {
  value: string;
  label: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-5 text-center ${accent ? "bg-gradient-to-br from-[#0a0a0a] to-[#404040] text-white" : "bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)]"}`}
    >
      <p
        className={`text-3xl md:text-4xl font-extrabold font-mono ${accent ? "text-cyan" : "text-primary"}`}
      >
        {value}
      </p>
      <p
        className={`text-sm font-semibold mt-1 ${accent ? "text-white" : "text-foreground"}`}
      >
        {label}
      </p>
      {sub && (
        <p
          className={`text-xs mt-0.5 ${accent ? "text-white/60" : "text-muted-foreground"}`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Fairness Page (Condensed)
   ══════════════════════════════════════════════════════════════════ */

export default function FairnessPage() {
  const t = useTranslations("fairness");

  return (
    <div className="bg-background min-h-screen pt-20">
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-surface-dim via-background to-[#E8F5F1] dark:to-[#0a1f1a]" />
        <div className="absolute top-20 right-10 w-64 h-64 rounded-full bg-cyan/5 blur-3xl" />
        <div className="absolute bottom-10 left-10 w-48 h-48 rounded-full bg-primary/5 blur-3xl" />

        <div className="max-w-5xl mx-auto px-6 py-20 md:py-28 relative z-10">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan/10 text-cyan text-sm font-semibold mb-6">
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
              {t("hero_badge")}
            </div>
            <h1 className="text-4xl md:text-5xl font-extrabold text-foreground leading-tight mb-5">
              {t("hero_title_1")}
              <br />
              <span className="text-primary">{t("hero_title_2")}</span>
            </h1>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed mb-10">
              {t("hero_subtitle")}
            </p>

            {/* Hero stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl mx-auto">
              <StatBlock
                value={t("hero_stat_1_value")}
                label={t("hero_stat_1_label")}
                sub={t("hero_stat_1_sub")}
              />
              <StatBlock
                value={t("hero_stat_2_value")}
                label={t("hero_stat_2_label")}
                sub={t("hero_stat_2_sub")}
                accent
              />
              <StatBlock
                value={t("hero_stat_3_value")}
                label={t("hero_stat_3_label")}
                sub={t("hero_stat_3_sub")}
              />
              <StatBlock
                value={t("hero_stat_4_value")}
                label={t("hero_stat_4_label")}
                sub={t("hero_stat_4_sub")}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ─── 4대 약속 (브랜드 헌법) ──────────────────────────── */}
      <section className="py-16 bg-gradient-to-b from-background to-surface-dim">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold mb-4">
              <span>⚖️</span>
              브랜드 헌법
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
              Pickket 4대 약속
            </h2>
            <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
              팬에게 강제로 약속하는 4가지. 위반 시 환불·보상이 자동
              트리거됩니다.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* P1 */}
            <div className="rounded-2xl bg-card p-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] border-l-4 border-primary">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">💰</span>
                <div>
                  <p className="text-xs font-mono font-bold text-primary mb-1">
                    P1 · ALL-IN PRICING
                  </p>
                  <h3 className="text-lg font-bold text-foreground">
                    숨은 수수료 0원
                  </h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                검색부터 결제까지{" "}
                <strong className="text-foreground">동일한 최종가</strong>. 결제
                직전 가격 변경 금지.
              </p>
              <p className="text-xs font-mono text-cyan">
                위반 시 → 차액 100% 즉시 환불 + 다음 예매 수수료 면제
              </p>
            </div>

            {/* P2 */}
            <div className="rounded-2xl bg-card p-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] border-l-4 border-cyan">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">🔒</span>
                <div>
                  <p className="text-xs font-mono font-bold text-cyan mb-1">
                    P2 · LOCKED TICKET
                  </p>
                  <h3 className="text-lg font-bold text-foreground">
                    암표 원천 차단
                  </h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                계정 바인딩 +{" "}
                <strong className="text-foreground">15초 동적 QR</strong>.
                스크린샷·PDF·종이 모두 무효.
              </p>
              <p className="text-xs font-mono text-cyan">
                위반 시 → 2차 거래 계정 영구정지 + 수익 몰수
              </p>
            </div>

            {/* P3 */}
            <div className="rounded-2xl bg-card p-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] border-l-4 border-[#4A5BC4]">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">🎯</span>
                <div>
                  <p className="text-xs font-mono font-bold text-[#4A5BC4] mb-1">
                    P3 · FACE-VALUE WAITLIST
                  </p>
                  <h3 className="text-lg font-bold text-foreground">
                    액면가 대기자
                  </h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                취소표는{" "}
                <strong className="text-foreground">원가 그대로</strong>{" "}
                대기자에게 자동 재배분. 수수료 가산 금지.
              </p>
              <p className="text-xs font-mono text-cyan">
                위반 시 → 재배분 실패 시 정가 100% 보상
              </p>
            </div>

            {/* P4 */}
            <div className="rounded-2xl bg-card p-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] border-l-4 border-primary">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">⚖️</span>
                <div>
                  <p className="text-xs font-mono font-bold text-primary mb-1">
                    P4 · FAIR DISTRIBUTION
                  </p>
                  <h3 className="text-lg font-bold text-foreground">
                    구조적 공정 배분
                  </h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                선착순·광클 없음.{" "}
                <strong className="text-foreground">
                  공정 추첨 + AP 가중치
                </strong>
                . 돈으로 AP 구매 절대 금지.
              </p>
              <p className="text-xs font-mono text-cyan">
                위반 시 → 해당 배분 전체 무효화 + 재경매
              </p>
            </div>
          </div>

          <p className="text-xs text-center text-muted-foreground mt-6">
            본 약속은{" "}
            <Link href="/terms" className="underline hover:text-primary">
              이용약관
            </Link>
            에 명시되어 있으며, 내부 정책 핸드북 §1.3에 근거합니다.
          </p>
        </div>
      </section>

      {/* ─── 핵심 방어 체계 ──────────────────────────────────── */}
      <section className="py-16">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-10">
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
              어떻게 공정성을 보장하나요?
            </h2>
            <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
              노벨 경제학상 수상 메커니즘 기반 공정 추첨과 다층 방어 시스템
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
            {[
              {
                emoji: "🎲",
                title: "공정 추첨 엔진",
                desc: "공정 배분 엔진 + 가중 랜덤. 선착순 대신 규칙 기반으로 배분하여 봇·매크로 무력화.",
              },
              {
                emoji: "🛡️",
                title: "5단계 봇 차단",
                desc: "레이트 리밋 → 행동 분석 → 대기열 제어 → 브라우저 핑거프린팅 → 토큰 검증.",
              },
              {
                emoji: "🔄",
                title: "15초 동적 QR",
                desc: "계정 바인딩 + 15초마다 자동 갱신. 스크린샷·전달 무효. 본인만 입장 가능.",
              },
              {
                emoji: "📊",
                title: "투명성 리포트",
                desc: "매 배분마다 결과를 공개. 팬이 직접 검증할 수 있는 공개 리포트 제공.",
              },
              {
                emoji: "🌏",
                title: "7개 언어 지원",
                desc: "한/영/일/중/프/러/베 자동 전환. 해외 팬도 동일한 공정성 보장.",
              },
              {
                emoji: "⚡",
                title: "AP 가중치 시스템",
                desc: "활동 기반 포인트로 진짜 팬 우선. 돈으로 구매 불가, 참여로만 적립.",
                link: "/guide/ap",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl bg-card p-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)]"
              >
                <span className="text-2xl">{item.emoji}</span>
                <h3 className="text-base font-bold text-foreground mt-3 mb-2">
                  {item.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {item.desc}
                </p>
                {item.link && (
                  <Link
                    href={item.link}
                    className="inline-block mt-3 text-xs text-primary hover:underline"
                  >
                    자세히 보기 →
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Before vs After ─────────────────────────────────── */}
      <section className="py-16 bg-gradient-to-b from-background to-surface-dim">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">
            {t("before_after_title")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {/* Before */}
            <div className="rounded-2xl bg-[#1a1a2e] p-8 shadow-[0_2px_16px_rgba(0,0,0,0.12)]">
              <h3 className="text-xl font-bold text-white mb-6">
                {t("before_title")}
              </h3>
              <div className="space-y-4">
                {[
                  { text: t("before_1_text"), detail: t("before_1_detail") },
                  { text: t("before_2_text"), detail: t("before_2_detail") },
                  { text: t("before_3_text"), detail: t("before_3_detail") },
                  { text: t("before_4_text"), detail: t("before_4_detail") },
                  { text: t("before_5_text"), detail: t("before_5_detail") },
                ].map((item) => (
                  <div key={item.text} className="flex items-start gap-3">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                      className="shrink-0 mt-0.5"
                    >
                      <circle
                        cx="10"
                        cy="10"
                        r="9"
                        stroke="#FF6B6B"
                        strokeWidth="1.5"
                      />
                      <line
                        x1="6"
                        y1="6"
                        x2="14"
                        y2="14"
                        stroke="#FF6B6B"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                      <line
                        x1="14"
                        y1="6"
                        x2="6"
                        y2="14"
                        stroke="#FF6B6B"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                    <div>
                      <p className="text-sm text-white/90">{item.text}</p>
                      <p className="text-xs text-white/40 mt-0.5">
                        {item.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* After */}
            <div className="rounded-2xl bg-card p-8 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)]">
              <h3 className="text-xl font-bold text-primary mb-6">
                {t("after_title")}
              </h3>
              <div className="space-y-4">
                {[
                  { text: t("after_1_text"), detail: t("after_1_detail") },
                  { text: t("after_2_text"), detail: t("after_2_detail") },
                  { text: t("after_3_text"), detail: t("after_3_detail") },
                  { text: t("after_4_text"), detail: t("after_4_detail") },
                  { text: t("after_5_text"), detail: t("after_5_detail") },
                ].map((item) => (
                  <div key={item.text} className="flex items-start gap-3">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                      className="shrink-0 mt-0.5"
                    >
                      <circle
                        cx="10"
                        cy="10"
                        r="9"
                        stroke="#00C9A7"
                        strokeWidth="1.5"
                      />
                      <polyline
                        points="6,10 9,13 14,7"
                        fill="none"
                        stroke="#00C9A7"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div>
                      <p className="text-sm text-foreground">{item.text}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FAQ ─────────────────────────────────────────────── */}
      <section className="py-16 bg-muted">
        <div className="max-w-3xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">
            {t("faq_title")}
          </h2>

          <div className="space-y-4">
            {[
              { q: t("faq_1_q"), a: t("faq_1_a") },
              { q: t("faq_2_q"), a: t("faq_2_a") },
              { q: t("faq_3_q"), a: t("faq_3_a") },
              { q: t("faq_4_q"), a: t("faq_4_a") },
              { q: t("faq_5_q"), a: t("faq_5_a") },
            ].map((faq) => (
              <div
                key={faq.q}
                className="rounded-2xl bg-white shadow-[0_2px_16px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] p-5 md:p-6"
              >
                <h4 className="font-bold text-foreground text-sm md:text-base mb-2 flex items-start gap-2">
                  <span className="text-primary shrink-0">Q.</span>
                  {faq.q}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed pl-5">
                  {faq.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="rounded-2xl p-10 md:p-14 bg-gradient-to-br from-[#0a0a0a] via-[#2A3A9E] to-[#404040]">
            <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center mx-auto mb-6">
              <svg
                className="h-8 w-8 text-cyan"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">
              {t("final_cta_title")}
            </h2>
            <p className="text-white/60 mb-8 max-w-md mx-auto text-sm">
              {t("final_cta_desc")}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/events"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full bg-cyan text-white font-semibold hover:bg-cyan/90 transition-colors text-sm"
              >
                {t("final_cta_browse")}
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
              <Link
                href="/for-organizers"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full border border-white/20 text-white font-semibold hover:bg-white/10 transition-colors text-sm"
              >
                주최자이신가요? →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
