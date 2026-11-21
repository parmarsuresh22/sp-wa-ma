import { useCallback, useState, useSyncExternalStore } from 'react';

/** Rows per page on a phone and on anything wider. */
export const PAGE_SIZE_MOBILE = 10;
export const PAGE_SIZE_DESKTOP = 20;

const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** True on a phone-width screen (below Tailwind's `md`). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/**
 * How many rows a list shows per page: 10 on a phone, 20 on a bigger
 * screen. Every paged list in the portal uses this, so they all change
 * together when the window is resized or the phone is turned.
 */
export function usePageSize(): number {
  return useIsMobile() ? PAGE_SIZE_MOBILE : PAGE_SIZE_DESKTOP;
}

/** The last valid page (0-based) for `total` rows. */
export function lastPage(total: number, pageSize: number): number {
  return Math.max(0, Math.ceil(total / Math.max(1, pageSize)) - 1);
}

/**
 * A page number that goes back to the first page by itself whenever
 * `key` changes (a new search, another filter, another list). Derived
 * during render, so there is no effect and no flash of an empty page.
 */
export function useKeyedPage(key: string): [number, (page: number) => void] {
  const [state, setState] = useState({ key, page: 0 });
  const page = state.key === key ? state.page : 0;
  const setPage = useCallback((next: number) => setState({ key, page: Math.max(0, next) }), [key]);
  return [page, setPage];
}
