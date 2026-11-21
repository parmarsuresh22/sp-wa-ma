'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

import { lastPage } from '@/hooks/use-page-size';
import { cn } from '@/lib/utils';

/**
 * First / previous / next / last for any paged list. Put one above the
 * list and one below it so the controls are always within reach.
 *
 * `page` is 0-based. Renders nothing when everything fits on one page.
 */
export function ListPager({
  page,
  pageSize,
  total,
  onChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  className?: string;
}) {
  const last = lastPage(total, pageSize);
  if (total <= pageSize) return null;
  const current = Math.min(Math.max(0, page), last);
  const from = current * pageSize + 1;
  const to = Math.min((current + 1) * pageSize, total);

  const button = (label: string, target: number, disabled: boolean, Icon: typeof ChevronLeft) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(target)}
      className="flex size-8 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <nav
      aria-label="Pages"
      className={cn('flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground', className)}
    >
      <span className="tabular-nums">
        {from}–{to} / {total}
      </span>
      <span className="flex items-center gap-1">
        {button('First page', 0, current === 0, ChevronsLeft)}
        {button('Previous page', current - 1, current === 0, ChevronLeft)}
        <span className="px-1.5 tabular-nums text-foreground">
          {current + 1} / {last + 1}
        </span>
        {button('Next page', current + 1, current >= last, ChevronRight)}
        {button('Last page', last, current >= last, ChevronsRight)}
      </span>
    </nav>
  );
}
