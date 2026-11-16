import { ImageResponse } from "next/og";

// 180×180 touch icon for iOS home screens / Safari pinned tabs — the
// same coral chevron as the favicon. iOS fills transparent areas with
// black and applies its own rounded mask, so the chevron is drawn on a
// transparent canvas rather than a square of our own.

export const runtime = "edge";
export const size = { width: 180, height: 180 };
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
          background: "transparent",
        }}
      >
        <svg
          width="150"
          height="150"
          viewBox="0 0 48 48"
          fill="none"
          stroke="#ff6d5a"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 33 L24 15 L40 33" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
