import { ImageResponse } from "next/og";

// 180×180 touch icon for iOS home screens / Safari pinned tabs — same
// brand mark as the favicon, with the square corners iOS expects (it
// applies its own mask).

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
          background: "#1b2335",
        }}
      >
        <svg
          width="180"
          height="180"
          viewBox="0 0 48 48"
          fill="none"
          stroke="#ff6d5a"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 31 L24 17 L36 31" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
