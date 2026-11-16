import { ImageResponse } from "next/og";

// Favicon: the brand mark (coral chevron on a navy rounded square),
// the same shape as `src/components/brand/brand-mark.tsx` which the
// sidebar and auth pages render. Next.js renders this at build time and
// auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
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
          background: "#1b2335",
          borderRadius: 6,
        }}
      >
        <svg
          width="32"
          height="32"
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
