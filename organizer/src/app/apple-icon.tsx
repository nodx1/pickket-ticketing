import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #6C5CE7 0%, #8B5CF6 55%, #059669 100%)",
          borderRadius: 40,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <div style={{ width: 48, height: 48, borderRadius: 14, background: "white" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ width: 28, height: 20, borderRadius: 7, background: "#A29BFE" }} />
              <div style={{ width: 28, height: 20, borderRadius: 7, background: "#00C9A7" }} />
            </div>
          </div>
          <div
            style={{
              color: "white",
              fontSize: 28,
              fontWeight: 900,
              letterSpacing: "-0.04em",
              marginTop: 4,
            }}
          >
            PICKKET.GO
          </div>
        </div>
      </div>
    ),
    size,
  );
}
