'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2, RotateCw, Search, Send, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListPager } from '@/components/ui/list-pager';
import { useKeyedPage, usePageSize } from '@/hooks/use-page-size';
import { money, type OrderRow } from '@/lib/events/types';
import { cn } from '@/lib/utils';
import { api, postJson, stamp, type EventView } from './shared';

const FILTERS = ['review', 'awaiting_payment', 'issued', 'closed', 'all'] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_STYLE: Record<string, string> = {
  review: 'border-violet-500/50 text-violet-300',
  awaiting_payment: 'border-amber-500/40 text-amber-300',
  issued: 'border-emerald-500/40 text-emerald-300',
  rejected: 'border-red-500/40 text-red-300',
  cancelled: 'border-border text-muted-foreground',
  expired: 'border-border text-muted-foreground',
};

/** Requests for passes and their payment proofs, with Approve and Reject. */
export function EventOrders({
  event,
  canAct,
  reviewCount,
  onChanged,
}: {
  event: EventView;
  canAct: boolean;
  reviewCount: number;
  onChanged: () => void;
}) {
  const t = useTranslations('Events');
  const pageSize = usePageSize();
  const [filter, setFilter] = useState<Filter>(reviewCount > 0 ? 'review' : 'all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useKeyedPage(`${event.id}|${filter}|${query}|${pageSize}`);
  const [data, setData] = useState<{ key: string; rows: OrderRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Fixed for this view, so "expired" does not flicker between renders.
  const [nowMs] = useState(() => Date.now());
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
    api<{ rows: OrderRow[]; total: number }>(`/api/events/${event.id}/orders?${params}`)
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
    async (order: OrderRow, action: 'approve' | 'reject' | 'cancel' | 'resend') => {
      if (action === 'reject' && !window.confirm(t('confirmReject'))) return;
      setBusy(`${order.id}:${action}`);
      try {
        const res = await api<{ message_error: string | null }>(
          `/api/events/orders/${order.id}`,
          postJson('PATCH', { action }),
        );
        if (res.message_error) toast.error(t('notSent', { error: res.message_error }), { duration: 10000 });
        else toast.success(t(`done.${action}`));
        setNonce((n) => n + 1);
        onChanged();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
        setNonce((n) => n + 1);
      } finally {
        setBusy(null);
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
            {t(`orderFilter.${f}`)}
            {f === 'review' && reviewCount > 0 ? ` (${reviewCount})` : ''}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('orderSearch')} />
      </div>

      {pager}
      {!loaded ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : loaded.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {filter === 'review' ? t('noReview') : t('noOrders')}
        </p>
      ) : (
        <ul className="space-y-2">
          {loaded.rows.map((o) => {
            const expired = o.status === 'awaiting_payment' && !!o.expires_at && Date.parse(o.expires_at) < nowMs;
            const shown = expired ? 'expired' : o.status;
            const reading = o.proof?.reading ?? null;
            const problems = o.proof?.problems ?? [];
            const open = o.status === 'review' || o.status === 'awaiting_payment';
            return (
              <li key={o.id} className="min-w-0 rounded-xl border border-border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{o.customer_name || t('noName')}</p>
                    <p className="text-xs text-muted-foreground">
                      {o.phone_key} · {t('orderCode', { code: o.code })} · {stamp(o.created_at)}
                    </p>
                  </div>
                  <Badge variant="outline" className={cn('font-normal', STATUS_STYLE[shown])}>
                    {t(`orderStatus.${shown}`)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-foreground">
                  {o.quantity} × {typeName(o.pass_type_id)} ·{' '}
                  <span className="font-semibold">{o.amount > 0 ? money(o.amount) : t('free')}</span>
                </p>

                {(o.proof_url || o.payment_ref || o.status === 'review') && (
                  <div className="mt-2 flex gap-3 rounded-lg border border-border bg-muted/40 p-2">
                    {o.proof_url && (
                      <a href={o.proof_url} target="_blank" rel="noreferrer" className="shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={o.proof_url} alt={t('screenshot')} className="h-24 w-16 rounded border border-border object-cover" />
                      </a>
                    )}
                    <div className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
                      {o.payment_ref && <p>{t('proofRef', { ref: o.payment_ref })}</p>}
                      {reading?.amount != null && <p>{t('proofAmount', { amount: money(reading.amount) })}</p>}
                      {(reading?.payee_upi || reading?.payee_name) && (
                        <p className="truncate">{t('proofPayee', { payee: reading.payee_upi || reading.payee_name || '' })}</p>
                      )}
                      {reading?.paid_on && <p>{t('proofDate', { date: reading.paid_on })}</p>}
                      {problems.length === 0 ? (
                        o.proof?.via ? <p className="text-emerald-400">{t('checksPassed')}</p> : null
                      ) : (
                        <ul className="list-disc pl-4 text-amber-300">
                          {problems.map((p) => (
                            <li key={p}>{t.has(`problem.${p}`) ? t(`problem.${p}`) : p}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {o.message_error && <p className="mt-2 text-xs text-red-400">{t('notSent', { error: o.message_error })}</p>}

                {canAct && (open || o.status === 'issued') && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {open && (
                      <Button size="sm" disabled={!!busy} onClick={() => act(o, 'approve')}>
                        {busy === `${o.id}:approve` ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                        {o.status === 'review' ? t('approve') : t('markPaid')}
                      </Button>
                    )}
                    {o.status === 'review' && (
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(o, 'reject')}>
                        {busy === `${o.id}:reject` ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                        {t('reject')}
                      </Button>
                    )}
                    {o.status === 'awaiting_payment' && (
                      <>
                        {o.amount > 0 && (
                          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(o, 'resend')}>
                            {busy === `${o.id}:resend` ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                            {t('resendQr')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(o, 'cancel')}>
                          {t('cancelRequest')}
                        </Button>
                      </>
                    )}
                    {o.status === 'issued' && (
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(o, 'resend')}>
                        {busy === `${o.id}:resend` ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                        {t('resendPasses')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pager}
    </div>
  );
}
