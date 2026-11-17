'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The number the agent is "working on" right now — one choice shared by
 * the inbox list, the dashboard and the contacts page, remembered per
 * browser. `"all"` or a whatsapp_config id. Browser-local on purpose:
 * each teammate comes back to the number they were on.
 */
export const ACTIVE_CHANNEL_KEY = 'wacrm.inbox.channel';
const ACTIVE_CHANNEL_EVENT = 'wacrm:inbox-channel';

export function readActiveChannel(): string {
  try {
    return window.localStorage.getItem(ACTIVE_CHANNEL_KEY) || 'all';
  } catch {
    return 'all';
  }
}

export function writeActiveChannel(value: string) {
  try {
    window.localStorage.setItem(ACTIVE_CHANNEL_KEY, value);
  } catch {
    /* private mode etc. — the choice just doesn't persist */
  }
  window.dispatchEvent(new Event(ACTIVE_CHANNEL_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(ACTIVE_CHANNEL_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(ACTIVE_CHANNEL_EVENT, onChange);
  };
}

/**
 * `[value, setValue]` for the active number. The server render sees
 * "all" so there is no hydration mismatch; the stored choice applies on
 * the client. Callers should treat an id that no longer exists as "all".
 */
export function useActiveChannel(): [string, (value: string) => void] {
  const value = useSyncExternalStore(subscribe, readActiveChannel, () => 'all');
  const set = useCallback((next: string) => writeActiveChannel(next), []);
  return [value, set];
}
