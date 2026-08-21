import type { Config } from "@measured/puck";

/* ── Block render functions for consumer-side rendering ── */
/* These match the Studio puck-config but are duplicated here to keep
   consumer independent from studio build artifacts. Only `render` functions
   are used by Puck's <Render /> component. */

const HeroBanner = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ title, subtitle, imageUrl, ctaText }: any) => (
    <div
      style={{
        background: imageUrl
          ? `linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,0.8)), url(${imageUrl}) center/cover`
          : "linear-gradient(135deg, #0a0a0a, #d4d4d4)",
        padding: "80px 32px",
        textAlign: "center" as const,
        borderRadius: "16px",
        color: "#fff",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", fontWeight: 800, marginBottom: 12 }}>
        {title}
      </h1>
      {subtitle && (
        <p style={{ fontSize: "1.1rem", opacity: 0.85, marginBottom: 24 }}>
          {subtitle}
        </p>
      )}
      {ctaText && (
        <button
          style={{
            padding: "12px 32px",
            borderRadius: "9999px",
            background: "#0a0a0a",
            color: "#fff",
            fontWeight: 700,
            border: "none",
            cursor: "pointer",
          }}
        >
          {ctaText}
        </button>
      )}
    </div>
  ),
};

const EventInfo = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ date, venue, artist, description }: any) => (
    <div
      style={{ padding: "32px", background: "#141418", borderRadius: "16px" }}
    >
      <h2
        style={{
          fontSize: "1.3rem",
          fontWeight: 700,
          marginBottom: 16,
          color: "#f1f1f3",
        }}
      >
        공연 정보
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {date && (
          <div style={{ color: "#8e8e9a", fontSize: "0.85rem" }}>📅 {date}</div>
        )}
        {venue && (
          <div style={{ color: "#8e8e9a", fontSize: "0.85rem" }}>
            📍 {venue}
          </div>
        )}
        {artist && (
          <div style={{ color: "#8e8e9a", fontSize: "0.85rem" }}>
            🎤 {artist}
          </div>
        )}
      </div>
      {description && (
        <p
          style={{
            marginTop: 16,
            color: "#8e8e9a",
            fontSize: "0.9rem",
            lineHeight: 1.6,
          }}
        >
          {description}
        </p>
      )}
    </div>
  ),
};

const CountdownBlock = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ label }: any) => (
    <div
      style={{
        textAlign: "center" as const,
        padding: "24px",
        background: "#141418",
        borderRadius: "16px",
      }}
    >
      <p style={{ color: "#8e8e9a", fontSize: "0.85rem", marginBottom: 8 }}>
        {label}
      </p>
      <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
        {["일", "시간", "분", "초"].map((u) => (
          <div key={u} style={{ textAlign: "center" as const }}>
            <div
              style={{ fontSize: "2rem", fontWeight: 800, color: "#d4d4d4" }}
            >
              --
            </div>
            <div style={{ fontSize: "0.7rem", color: "#8e8e9a" }}>{u}</div>
          </div>
        ))}
      </div>
    </div>
  ),
};

const TrustBadges = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 16,
        padding: "24px",
      }}
    >
      {[
        { emoji: "🛡️", title: "공정 배분", desc: "공정 추첨" },
        { emoji: "✅", title: "정가 보장", desc: "암표 방지" },
        { emoji: "🎫", title: "안심 결제", desc: "자동 환불" },
      ].map((b) => (
        <div key={b.title} style={{ textAlign: "center" as const }}>
          <div style={{ fontSize: "1.5rem" }}>{b.emoji}</div>
          <div
            style={{
              fontWeight: 600,
              fontSize: "0.85rem",
              color: "#f1f1f3",
              marginTop: 4,
            }}
          >
            {b.title}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#8e8e9a" }}>{b.desc}</div>
        </div>
      ))}
    </div>
  ),
};

const ImageGallery = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ images }: any) => {
    const urls = (images || "").split("\n").filter(Boolean);
    if (urls.length === 0)
      return (
        <div
          style={{
            padding: 32,
            textAlign: "center" as const,
            color: "#8e8e9a",
          }}
        >
          이미지를 추가하세요
        </div>
      );
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 8,
        }}
      >
        {urls.map((url: string, i: number) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={url}
            alt=""
            style={{
              width: "100%",
              borderRadius: 12,
              aspectRatio: "16/9",
              objectFit: "cover",
            }}
          />
        ))}
      </div>
    );
  },
};

const FAQ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ items }: any) => {
    const faqs = (items || "")
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [q, a] = line.split("::");
        return { q, a };
      });
    return (
      <div style={{ padding: 24 }}>
        <h2
          style={{
            fontSize: "1.2rem",
            fontWeight: 700,
            color: "#f1f1f3",
            marginBottom: 16,
          }}
        >
          자주 묻는 질문
        </h2>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {faqs.map((faq: any, i: number) => (
          <div
            key={i}
            style={{
              padding: "12px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <div
              style={{ fontWeight: 600, color: "#f1f1f3", fontSize: "0.9rem" }}
            >
              {faq.q}
            </div>
            {faq.a && (
              <div
                style={{ color: "#8e8e9a", fontSize: "0.85rem", marginTop: 4 }}
              >
                {faq.a}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  },
};

const TextBlock = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ content, align }: any) => (
    <div
      style={{
        padding: 24,
        textAlign: align,
        color: "#f1f1f3",
        whiteSpace: "pre-wrap" as const,
      }}
    >
      {content}
    </div>
  ),
};

const Spacer = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ({ height }: any) => <div style={{ height: `${height}px` }} />,
};

/* ── Puck Config (render-only) ── */

export const puckConfig: Config = {
  components: {
    HeroBanner,
    EventInfo,
    CountdownBlock,
    TrustBadges,
    ImageGallery,
    FAQ,
    TextBlock,
    Spacer,
  },
};
