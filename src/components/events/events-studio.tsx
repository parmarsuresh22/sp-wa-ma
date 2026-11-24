'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, CalendarDays, Loader2, MapPin, Pencil, Plus, QrCode, ScanLine, Ticket, UserPlus, Wallet } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListPager } from '@/components/ui/list-pager';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { useKeyedPage, usePageSize } from '@/hooks/use-page-size';
import { money } from '@/lib/events/types';
import { cn } from '@/lib/utils';
import { EventForm } from './event-form';
import { EventOrders } from './event-orders';
import { EventPasses } from './event-passes';
import { IssuePass } from './issue-pass';
import { PassScanner } from './pass-scanner';
import { Label, api, field, totalsFor, when, type EventView, type TypeStats } from './shared';

type Tab = 'orders' | 'passes' | 'issue' | 'scan' | 'edit';

const EVENT_STATUS_STYLE: Record<string, string> = {
  open: 'border-emerald-500/40 text-emerald-300',
  closed: 'border-amber-500/40 text-amber-300',
  cancelled: 'border-red-500/40 text-red-300',
  over: 'border-border text-muted-foreground',
};

interface Loaded {
  channelId: string;
  events: EventView[];
  stats: TypeStats[];
}

export function EventsStudio() {
  const t = useTranslations('Events');
  const { canEditSettings, canSendMessages } = useAuth();
  const { channels } = useChannels();
  const pageSize = usePageSize();

  const list = useMemo(() => channels ?? [], [channels]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel = list.find((c) => c.id === channelId) ?? list[0] ?? null;
  const fromId = channel?.id ?? null;

  const [data, setData] = useState<Loaded | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('orders');
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useKeyedPage(`${fromId}|${pageSize}`);
  const [nowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!fromId) return;
    try {
      const res = await api<{ events: EventView[]; stats: TypeStats[] }>(`/api/events?channel_id=${fromId}`);
      setData({ channelId: fromId, events: res.events, stats: res.stats });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setData((prev) => (prev && prev.channelId === fromId ? prev : { channelId: fromId, events: [], stats: [] }));
    }
  }, [fromId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const loaded = data && data.channelId === fromId ? data : null;
  const selected = loaded?.events.find((e) => e.id === selectedId) ?? null;
  const shownStatus = (e: EventView) => (e.status === 'open' && Date.parse(e.starts_at) < nowMs ? 'over' : e.status);

  const saved = (event: EventView) => {
    setCreating(false);
    setSelectedId(event.id);
    setTab('orders');
    void load();
  };

  return (
    <div className="min-w-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {!channels ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : !fromId ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noNumber')}
        </p>
      ) : creating ? (
        <div className="mt-5 max-w-2xl">
          <h2 className="mb-3 text-lg font-semibold text-foreground">{t('newEvent')}</h2>
          <EventForm channelId={fromId} event={null} onSaved={saved} onCancel={() => setCreating(false)} />
        </div>
      ) : selected ? (
        <EventDetail
          key={selected.id}
          event={selected}
          stats={loaded?.stats ?? []}
          status={shownStatus(selected)}
          tab={tab}
          setTab={setTab}
          canEdit={canEditSettings}
          canAct={canSendMessages}
          onBack={() => setSelectedId(null)}
          onChanged={load}
          onSaved={saved}
        />
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-end gap-3">
            <Label text={t('number')}>
              <select
                className={cn(field, 'w-full sm:w-72')}
                value={fromId}
                onChange={(e) => {
                  // Each number has its own events.
                  setChannelId(e.target.value);
                  setData(null);
                }}
              >
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {channelLabel(c)}
                    {c.display_phone && c.label ? ` · ${c.display_phone}` : ''}
                  </option>
                ))}
              </select>
            </Label>
            {canEditSettings && (
              <Button type="button" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                {t('newEvent')}
              </Button>
            )}
          </div>

          {!loaded ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : loaded.events.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <Ticket className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-foreground">{t('emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{t('emptyHint')}</p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {loaded.events.length > pageSize && (
                <ListPager page={page} pageSize={pageSize} total={loaded.events.length} onChange={setPage} />
              )}
              <ul className="grid gap-3 md:grid-cols-2">
                {loaded.events.slice(page * pageSize, page * pageSize + pageSize).map((e) => {
                  const totals = totalsFor(e, loaded.stats);
                  const status = shownStatus(e);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(e.id);
                          setTab(totals.review > 0 ? 'orders' : 'passes');
                        }}
                        className="block w-full min-w-0 rounded-xl border border-border bg-card p-4 text-left hover:border-primary"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate text-base font-semibold text-foreground">{e.name}</p>
                          <Badge variant="outline" className={cn('shrink-0 font-normal', EVENT_STATUS_STYLE[status])}>
                            {t(`eventStatus.${status}`)}
                          </Badge>
                        </div>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CalendarDays className="size-3.5 shrink-0" />
                          {when(e.starts_at, e.timezone)}
                        </p>
                        {e.venue && (
                          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <MapPin className="size-3.5 shrink-0" />
                            <span className="truncate">{e.venue}</span>
                          </p>
                        )}
                        <p className="mt-3 text-sm text-foreground">
                          {t('cardCounts', { issued: totals.issued, capacity: totals.capacity, used: totals.used })}
                        </p>
                        {totals.review > 0 && (
                          <p className="mt-1 text-sm font-medium text-violet-300">{t('cardReview', { count: totals.review })}</p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {loaded.events.length > pageSize && (
                <ListPager page={page} pageSize={pageSize} total={loaded.events.length} onChange={setPage} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EventDetail({
  event,
  stats,
  status,
  tab,
  setTab,
  canEdit,
  canAct,
  onBack,
  onChanged,
  onSaved,
}: {
  event: EventView;
  stats: TypeStats[];
  status: string;
  tab: Tab;
  setTab: (tab: Tab) => void;
  canEdit: boolean;
  canAct: boolean;
  onBack: () => void;
  onChanged: () => void;
  onSaved: (event: EventView) => void;
}) {
  const t = useTranslations('Events');
  const totals = totalsFor(event, stats);
  const tabs: [Tab, string, typeof Ticket][] = [
    ['orders', t('tabOrders'), Wallet],
    ['passes', t('tabPasses'), QrCode],
    ...(canAct
      ? ([
          ['issue', t('tabIssue'), UserPlus],
          ['scan', t('tabScan'), ScanLine],
        ] as [Tab, string, typeof Ticket][])
      : []),
    ...(canEdit ? ([['edit', t('tabEdit'), Pencil]] as [Tab, string, typeof Ticket][]) : []),
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : 'orders';

  return (
    <div className="mt-4">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {t('allEvents')}
      </button>

      <div className="mt-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold text-foreground">{event.name}</h2>
          <Badge variant="outline" className={cn('font-normal', EVENT_STATUS_STYLE[status])}>
            {t(`eventStatus.${status}`)}
          </Badge>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CalendarDays className="size-4 shrink-0" />
          {when(event.starts_at, event.timezone)}
        </p>
        {event.venue && (
          <p className="mt-0.5 flex items-start gap-1.5 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{event.venue}</span>
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(
            [
              [t('statIssued'), `${totals.issued} / ${totals.capacity}`],
              [t('statCheckedIn'), String(totals.used)],
              [t('statReview'), String(totals.review)],
              [t('statAwaiting'), String(totals.awaiting)],
              [t('statCollected'), money(totals.revenue)],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="truncate text-lg font-semibold text-foreground">{value}</p>
              <p className="truncate text-[11px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {event.pass_types.map((p) => {
            const s = stats.find((row) => row.pass_type_id === p.id);
            return (
              <li key={p.id} className="flex flex-wrap justify-between gap-x-3">
                <span className={cn('text-foreground', !p.active && 'line-through opacity-60')}>
                  {p.name} · {p.price > 0 ? money(p.price) : t('free')}
                </span>
                <span>{t('typeLine', { held: s?.held ?? 0, capacity: p.capacity, used: s?.used ?? 0 })}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
              current === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
            {key === 'orders' && totals.review > 0 && (
              <span className="rounded-full bg-violet-500/30 px-1.5 text-[11px] text-violet-200">{totals.review}</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {current === 'orders' && <EventOrders event={event} canAct={canAct} reviewCount={totals.review} onChanged={onChanged} />}
        {current === 'passes' && <EventPasses event={event} canAct={canAct} onChanged={onChanged} />}
        {current === 'issue' && <div className="max-w-2xl"><IssuePass event={event} stats={stats} onIssued={onChanged} /></div>}
        {current === 'scan' && <PassScanner event={event} checkedIn={totals.used} issued={totals.issued} onScanned={onChanged} />}
        {current === 'edit' && (
          <div className="max-w-2xl">
            <EventForm channelId={event.channel_id} event={event} onSaved={onSaved} onCancel={() => setTab('orders')} />
          </div>
        )}
      </div>
    </div>
  );
}
