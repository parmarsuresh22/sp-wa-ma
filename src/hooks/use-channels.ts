'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WhatsAppConfig } from '@/types';

/** A channel as the browser sees it — no secrets (see toPublicChannel). */
export type ChannelSummary = Pick<
  WhatsAppConfig,
  | 'id'
  | 'provider'
  | 'label'
  | 'display_phone'
  | 'is_default'
  | 'status'
  | 'phone_number_id'
  | 'waba_id'
  | 'bridge_base_url'
  | 'bridge_session'
  | 'bridge_status'
  | 'registered_at'
  | 'mirror_inbound_media'
  | 'connected_at'
>;

// Module-level cache so the inbox list, the thread header and the
// broadcast wizard share one fetch per page load; `refresh()` busts it.
let cache: ChannelSummary[] | null = null;
let inflight: Promise<ChannelSummary[]> | null = null;
const listeners = new Set<(rows: ChannelSummary[]) => void>();

async function fetchChannels(): Promise<ChannelSummary[]> {
  const res = await fetch('/api/whatsapp/channels', { cache: 'no-store' });
  if (!res.ok) throw new Error(`channels ${res.status}`);
  const body = (await res.json()) as { channels?: ChannelSummary[] };
  return body.channels ?? [];
}

function load(force = false): Promise<ChannelSummary[]> {
  if (!force && cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetchChannels()
      .then((rows) => {
        cache = rows;
        listeners.forEach((fn) => fn(rows));
        return rows;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Human label for a channel: name, else number, else id. */
export function channelLabel(ch: Pick<ChannelSummary, 'label' | 'display_phone' | 'phone_number_id' | 'bridge_session'> | null | undefined): string {
  if (!ch) return '';
  return (
    (ch.label && ch.label.trim()) ||
    (ch.display_phone && ch.display_phone.trim()) ||
    ch.phone_number_id ||
    ch.bridge_session ||
    'WhatsApp'
  );
}

/**
 * The account's WhatsApp numbers (default first). `channels` is null
 * until the first load resolves; an error leaves it as an empty list.
 */
export function useChannels() {
  const [channels, setChannels] = useState<ChannelSummary[] | null>(cache);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await load(true);
      setChannels(rows);
      setError(null);
    } catch (err) {
      setChannels((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onUpdate = (rows: ChannelSummary[]) => setChannels(rows);
    listeners.add(onUpdate);
    if (cache === null) {
      load()
        .then((rows) => setChannels(rows))
        .catch((err) => {
          setChannels([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setLoading(false));
    }
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);

  const byId = useCallback(
    (id: string | null | undefined) => (id ? channels?.find((c) => c.id === id) ?? null : null),
    [channels],
  );

  return { channels, loading, error, refresh, byId };
}
