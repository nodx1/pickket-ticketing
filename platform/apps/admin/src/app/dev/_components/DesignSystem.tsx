"use client";

import { useTranslations } from "next-intl";

const BRAND_COLORS = [
  { name: "Navy Deep", hex: "#0a0a14", usageKey: "color.navyDeep" },
  { name: "Navy Dark", hex: "#0d0d1a", usageKey: "color.navyDark" },
  { name: "Navy Surface", hex: "#12121f", usageKey: "color.navySurface" },
  { name: "Brand Purple", hex: "#6c5ce7", usageKey: "color.brandPurple" },
  { name: "Violet", hex: "#a855f7", usageKey: "color.violet" },
  { name: "Cyan", hex: "#00d2a0", usageKey: "color.cyan" },
  { name: "Amber", hex: "#eab308", usageKey: "color.amber" },
  { name: "Red", hex: "#ef4444", usageKey: "color.red" },
  { name: "Green", hex: "#22c55e", usageKey: "color.green" },
  { name: "Orange", hex: "#f97316", usageKey: "color.orange" },
];

const GRADIENTS = [
  {
    name: "Brand Hero",
    css: "linear-gradient(135deg, #6c5ce7, #a855f7)",
    usageKey: "gradient.brandHero",
  },
  {
    name: "Cyan Mint",
    css: "linear-gradient(135deg, #00d2a0, #22c55e)",
    usageKey: "gradient.cyanMint",
  },
  {
    name: "Amber Warm",
    css: "linear-gradient(135deg, #f97316, #eab308)",
    usageKey: "gradient.amberWarm",
  },
  {
    name: "Dark Mesh",
    css: "linear-gradient(135deg, #0d0d1a, #1a1a2e)",
    usageKey: "gradient.darkMesh",
  },
  {
    name: "Progress",
    css: "linear-gradient(90deg, #6c5ce7, #00d2a0)",
    usageKey: "gradient.progress",
  },
  {
    name: "Pink Neon",
    css: "linear-gradient(135deg, #ec4899, #a855f7)",
    usageKey: "gradient.pinkNeon",
  },
];

const CSS_TOKENS = [
  { token: "--pk-bg", value: "#0d0d1a", descKey: "token.pkBg" },
  { token: "--pk-surface", value: "#12121f", descKey: "token.pkSurface" },
  { token: "--pk-surface-2", value: "#1a1a2e", descKey: "token.pkSurface2" },
  { token: "--pk-border", value: "#1f1f35", descKey: "token.pkBorder" },
  { token: "--pk-text", value: "#f0f0f5", descKey: "token.pkText" },
  { token: "--pk-text-secondary", value: "#8888aa", descKey: "token.pkTextSecondary" },
  { token: "--pk-accent", value: "#6c5ce7", descKey: "token.pkAccent" },
];

const TYPOGRAPHY = [
  { name: "Display", cls: "text-4xl font-extrabold", sampleKey: null, sample: "Pickket" },
  { name: "H1", cls: "text-2xl font-bold", sampleKey: "typography.h1Sample", sample: "" },
  { name: "H2", cls: "text-xl font-semibold", sampleKey: "typography.h2Sample", sample: "" },
  { name: "H3", cls: "text-base font-semibold", sampleKey: "typography.h3Sample", sample: "" },
  {
    name: "Body",
    cls: "text-sm",
    sampleKey: "typography.bodySample",
    sample: "",
  },
  {
    name: "Caption",
    cls: "text-xs text-[#8888aa]",
    sampleKey: "typography.captionSample",
    sample: "",
  },
  { name: "Mono", cls: "text-xs font-mono", sampleKey: null, sample: "/api/v1/events/{id}" },
];

const SPACING = [2, 4, 6, 8, 12, 16, 20, 24];
const RADII = [
  { name: "sm", px: "4px", cls: "rounded" },
  { name: "md", px: "8px", cls: "rounded-lg" },
  { name: "lg", px: "12px", cls: "rounded-xl" },
  { name: "full", px: "9999px", cls: "rounded-full" },
];

const EASINGS = [
  {
    name: "ease-out",
    css: "cubic-bezier(0, 0, 0.2, 1)",
    usageKey: "easing.easeOut",
  },
  {
    name: "ease-in",
    css: "cubic-bezier(0.4, 0, 1, 1)",
    usageKey: "easing.easeIn",
  },
  {
    name: "ease-in-out",
    css: "cubic-bezier(0.4, 0, 0.2, 1)",
    usageKey: "easing.easeInOut",
  },
  {
    name: "spring",
    css: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    usageKey: "easing.spring",
  },
];

export function DesignSystem() {
  const t = useTranslations("dev.designSystem");

  return (
    <div className="space-y-6">
      {/* 브랜드 컬러 */}
      <section>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("brandColors")}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {BRAND_COLORS.map((c) => (
            <div
              key={c.hex}
              className="rounded-xl overflow-hidden border border-[var(--pk-border)]"
            >
              <div className="h-12" style={{ backgroundColor: c.hex }} />
              <div className="bg-[var(--pk-surface)] px-2.5 py-2">
                <p className="text-xs font-semibold text-[var(--pk-text)]">
                  {c.name}
                </p>
                <p className="text-[10px] font-mono text-[var(--pk-text-secondary)]">
                  {c.hex}
                </p>
                <p className="text-[10px] text-[var(--pk-text-secondary)]">
                  {t(c.usageKey)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CSS 토큰 */}
      <section>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("cssTokens")}
        </h2>
        <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--pk-border)] bg-[var(--pk-surface-2,#1a1a2e)]">
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Token
                </th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Value
                </th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Preview
                </th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pk-border)]">
              {CSS_TOKENS.map((tok) => (
                <tr
                  key={tok.token}
                  className="hover:bg-[var(--pk-surface-2,#1a1a2e)]"
                >
                  <td className="px-3 py-2 font-mono text-[var(--pk-accent)]">
                    {tok.token}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--pk-text-secondary)]">
                    {tok.value}
                  </td>
                  <td className="px-3 py-2">
                    <div
                      className="h-5 w-10 rounded border border-[var(--pk-border)]"
                      style={{ backgroundColor: tok.value }}
                    />
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)]">
                    {t(tok.descKey)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 그라디언트 */}
      <section>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("gradients")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {GRADIENTS.map((g) => (
            <div
              key={g.name}
              className="rounded-xl border border-[var(--pk-border)] overflow-hidden"
            >
              <div className="h-16" style={{ background: g.css }} />
              <div className="bg-[var(--pk-surface)] px-3 py-2">
                <p className="text-xs font-semibold text-[var(--pk-text)]">
                  {g.name}
                </p>
                <p className="text-[10px] font-mono text-[var(--pk-text-secondary)] truncate">
                  {g.css}
                </p>
                <p className="text-[10px] text-[var(--pk-text-secondary)]">
                  {t(g.usageKey)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 타이포그래피 */}
      <section>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("typography")}
        </h2>
        <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] divide-y divide-[var(--pk-border)]">
          {TYPOGRAPHY.map((typ) => (
            <div key={typ.name} className="flex items-center gap-4 px-4 py-3">
              <span className="text-[10px] font-mono text-[var(--pk-text-secondary)] w-16 shrink-0">
                {typ.name}
              </span>
              <span className={`flex-1 text-[var(--pk-text)] ${typ.cls}`}>
                {typ.sampleKey ? t(typ.sampleKey) : typ.sample}
              </span>
              <span className="text-[10px] font-mono text-[var(--pk-text-secondary)] hidden sm:block shrink-0">
                {typ.cls.split(" ")[0]}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Spacing + Radius */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <section>
          <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
            Spacing Scale
          </h2>
          <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 space-y-2">
            {SPACING.map((n) => (
              <div key={n} className="flex items-center gap-3">
                <span className="text-xs font-mono text-[var(--pk-text-secondary)] w-8">
                  {n}
                </span>
                <div
                  className="bg-[var(--pk-accent)] h-3 rounded"
                  style={{ width: `${n * 4}px` }}
                />
                <span className="text-[10px] text-[var(--pk-text-secondary)]">
                  {n * 4}px
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
            Border Radius
          </h2>
          <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 space-y-3">
            {RADII.map((r) => (
              <div key={r.name} className="flex items-center gap-3">
                <div
                  className="h-8 w-20 border-2 border-[var(--pk-accent)] shrink-0"
                  style={{ borderRadius: r.px }}
                />
                <div>
                  <p className="text-xs font-semibold text-[var(--pk-text)]">
                    {r.cls}
                  </p>
                  <p className="text-[10px] font-mono text-[var(--pk-text-secondary)]">
                    {r.px}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Easing */}
      <section>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("animationEasing")}
        </h2>
        <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--pk-border)] bg-[var(--pk-surface-2,#1a1a2e)]">
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  Name
                </th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)]">
                  CSS
                </th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--pk-text-secondary)] hidden sm:table-cell">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pk-border)]">
              {EASINGS.map((e) => (
                <tr
                  key={e.name}
                  className="hover:bg-[var(--pk-surface-2,#1a1a2e)]"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--pk-text)]">
                    {e.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--pk-text-secondary)]">
                    {e.css}
                  </td>
                  <td className="px-3 py-2 text-[var(--pk-text-secondary)] hidden sm:table-cell">
                    {t(e.usageKey)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
