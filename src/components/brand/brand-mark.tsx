import type { SVGProps } from 'react';

/**
 * The brand mark: a coral chevron on a transparent background. Drawn
 * as inline SVG so it stays crisp from the 16px browser tab to the
 * login card. The colour is fixed (not a theme token) on purpose: the
 * logo must look the same in light and dark mode. `src/app/icon.tsx`
 * and `src/app/apple-icon.tsx` draw the same shape for the favicon
 * and the iOS touch icon.
 */
export const BRAND_CORAL = '#ff6d5a';

/** Chevron geometry on a 48×48 box — shared with the icon routes. */
export const BRAND_CHEVRON_PATH = 'M8 33 L24 15 L40 33';
export const BRAND_CHEVRON_STROKE = 10;

export function BrandMark({
  className,
  title = 'wacrm',
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      className={className}
      {...props}
    >
      <path
        d={BRAND_CHEVRON_PATH}
        fill="none"
        stroke={BRAND_CORAL}
        strokeWidth={BRAND_CHEVRON_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
