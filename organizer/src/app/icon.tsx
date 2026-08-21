import { ImageResponse } from "next/og";

export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: "white",
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div style={{ width: 10, height: 8, borderRadius: 3, background: "#A29BFE" }} />
            <div style={{ width: 10, height: 8, borderRadius: 3, background: "#00C9A7" }} />
          </div>
        </div>
      </div>
    ),
    size,
  );
}
