import { useEffect, type RefObject } from 'react';

/** Close enough to the end to count as "reading the newest message". */
const NEAR_BOTTOM_PX = 80;

/**
 * Keep a chat scrolled to its newest message, the way WhatsApp does.
 *
 * Scrolling to the end once, when the messages arrive, is not enough:
 * pictures and videos have no height until they load, and each one that
 * loads pushes the end further down, leaving the reader a few messages
 * above the newest. The phone keyboard opening has the same effect.
 *
 * So while the reader is at (or near) the end, every later change in
 * height puts them back at the end. Once they scroll up to read older
 * messages, nothing moves them.
 *
 * `resetKey` re-attaches the listeners when the scroll element is
 * replaced (a different chat, or a loading state that swaps it out).
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, resetKey?: unknown): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let pinned = true;
    const onScroll = () => {
      pinned = el.scrollHeight - el.clientHeight - el.scrollTop < NEAR_BOTTOM_PX;
    };
    const settle = () => {
      if (pinned) el.scrollTop = el.scrollHeight;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    // `load` does not bubble, so listen in the capture phase to hear
    // every picture, video poster and embedded frame inside.
    el.addEventListener('load', settle, true);
    el.addEventListener('loadedmetadata', settle, true);
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(settle) : null;
    resize?.observe(el);
    settle();

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', settle, true);
      el.removeEventListener('loadedmetadata', settle, true);
      resize?.disconnect();
    };
  }, [ref, resetKey]);
}
