'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListPager } from '@/components/ui/list-pager';
import { useKeyedPage, usePageSize } from '@/hooks/use-page-size';
import type { PassRow } from '@/lib/events/types';
import { cn } from '@/lib/utils';
import { api, postJson, stamp, type EventView } from './shared';

const FILTERS = ['all', 'valid', 'used', 'cancelled'] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_STYLE: Record<string, string> = {
  valid: 'border-sky-500/40 text-sky-300',
  used: 'border-emerald-500/40 text-emerald-300',
  cancelled: 'border-red-500/40 text-red-300',
};

/**
 * Every pass of the event. Search by name, phone or code to admit a
 * guest whose screen will not scan, or to cancel a pass.
 */
export function EventPasses({ event, canAct, onChanged }: { event: EventView; canAct: boolean; onChanged: () => void }) {
  const t = useTranslations('Events');
  const pageSize = usePageSize();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useKeyedPage(`${event.id}|${filter}|${query}|${pageSize}`);
  const [data, setData] = useState<{ key: string; rows: PassRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = `${event.id}|${filter}|${query}|${pageSize}|${page}`;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) });
    if (filter !== 'all') params.set('status', filter);
    if (query) params.set('q', query);
    api<{ rows: PassRow[]; total: number }>(`/api/events/${event.id}/passes?${params}`)
      .then((res) => {
        if (!cancelled) setData({ key, rows: res.rows, total: res.total });
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : String(err));
          setData({ key, rows: [], total: 0 });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, filter, query, page, pageSize, key, nonce]);

  const act = useCallback(
    async (pass: PassRow, action: 'checkin' | 'undo' | 'cancel' | 'restore') => {
      if (action === 'cancel' && !window.confirm(t('confirmCancelPass'))) return;
      setBusy(`${pass.id}:${action}`);
      try {
        const res = await api<{ scan?: { result: string } }>(`/api/events/passes/${pass.id}`, postJson('PATCH', { action }));
        if (action === 'checkin' && res.scan && res.scan.result !== 'ok') toast.error(t(`scan.${res.scan.result}`));
        else toast.success(t(`passDone.${action}`));
        onChanged();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
      } finally {
        setBusy(null);
        setNonce((n) => n + 1);
      }
    },
    [onChanged, t],
  );

  const loaded = data && data.key === key ? data : null;
  const typeName = (id: string) => event.pass_types.find((p) => p.id === id)?.name ?? '';
  const pager = loaded && loaded.total > pageSize ? (
    <ListPager page={page} pageSize={pageSize} total={loaded.total} onChange={setPage} />
  ) : null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('passSearch')} />
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs',
              filter === f ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`passFilter.${f}`)}
          </button>
        ))}
      </div>

      {pager}
      {!loaded ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : loaded.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noPasses')}
        </p>
      ) : (
        <ul className="space-y-2">
          {loaded.rows.map((p) => (
            <li key={p.id} className="min-w-0 rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{p.holder_name || t('noName')}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.phone_key} · {typeName(p.pass_type_id)} · {t('passNumber', { n: p.seq })} · …{p.code.slice(-6)}
                  </p>
                </div>
                <Badge variant="outline" className={cn('font-normal', STATUS_STYLE[p.status])}>
                  {t(`passStatus.${p.status}`)}
                </Badge>
              </div>
              {p.status === 'used' && p.used_at && (
                <p className="mt-1 text-xs text-muted-foreground">{t('usedAt', { time: stamp(p.used_at) })}</p>
              )}
              {canAct && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {p.status === 'valid' && (
                    <>
                      <Button size="sm" disabled={!!busy} onClick={() => act(p, 'checkin')}>
                        {busy === `${p.id}:checkin` && <Loader2 className="size-4 animate-spin" />}
                        {t('checkIn')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(p, 'cancel')}>
                        {t('cancelPass')}
                      </Button>
                    </>
                  )}
                  {p.status === 'used' && (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(p, 'undo')}>
                      {t('undoCheckIn')}
                    </Button>
                  )}
                  {p.status === 'cancelled' && (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(p, 'restore')}>
                      {t('restorePass')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pager}
    </div>
  );
}
