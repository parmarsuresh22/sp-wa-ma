'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { TabsList } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * A tab strip that never shows scrollbars: when the tabs do not fit,
 * left / right arrow buttons appear and move the strip instead.
 */
export function ScrollableTabsList({
  children,
  className,
  wrapperClassName,
  previousLabel,
  nextLabel,
}: {
  children: ReactNode;
  className?: string;
  wrapperClassName?: string;
  previousLabel: string;
  nextLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, [update]);

  const move = (direction: 1 | -1) =>
    ref.current?.scrollBy({ left: direction * 160, behavior: 'smooth' });

  const overflowing = edges.left || edges.right;
  const arrowClass =
    'flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

  return (
    <div className={cn('flex items-center gap-1', wrapperClassName)}>
      {overflowing ? (
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={!edges.left}
          aria-label={previousLabel}
          className={arrowClass}
        >
          <ChevronLeft className="size-4" />
        </button>
      ) : null}
      <TabsList
        ref={ref}
        className={cn(
          'w-auto min-w-0 flex-1 justify-start overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
      >
        {children}
      </TabsList>
      {overflowing ? (
        <button
          type="button"
          onClick={() => move(1)}
          disabled={!edges.right}
          aria-label={nextLabel}
          className={arrowClass}
        >
          <ChevronRight className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
