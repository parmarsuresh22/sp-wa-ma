import type { SVGProps } from 'react';

/**
 * The brand mark: a coral chevron on a navy rounded square. Drawn as
 * inline SVG so it stays crisp from the 16px browser tab to the login
 * card. Colours are fixed (not theme tokens) on purpose: the logo must
 * look the same in light and dark mode. `src/app/icon.tsx` draws the
 * same shape for the favicon.
 */
export const BRAND_NAVY = '#1b2335';
export const BRAND_CORAL = '#ff6d5a';

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
      <rect width="48" height="48" rx="9" fill={BRAND_NAVY} />
      <path
        d="M12 31 L24 17 L36 31"
        fill="none"
        stroke={BRAND_CORAL}
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
