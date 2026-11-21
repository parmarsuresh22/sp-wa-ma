'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CalendarCheck,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { contactSearchFilter } from '@/lib/contacts/search-filter';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import type { AppointmentSettings, HoursRange, ReminderMode } from '@/lib/appointments/time';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------
// Shapes
// ------------------------------------------------------------

type Status = 'booked' | 'completed' | 'cancelled' | 'no_show';

interface Appointment {
  id: string;
  channel_id: string;
  contact_id: string;
  customer_name: string | null;
  phone_key: string;
  starts_at: string;
  ends_at: string;
  status: Status;
  source: 'ai' | 'portal';
  treatment: string | null;
  medicine: string | null;
  notes: string | null;
  reminder_at: string | null;
  reminder_sent_at: string | null;
  reminder_error: string | null;
  contact?: { name: string | null; phone: string | null } | null;
}

interface SettingsBundle {
  settings: AppointmentSettings;
  provider: 'meta' | 'waha';
  templates: { name: string; language: string }[];
  template_examples: { confirm: string; reminder: string };
  ai: { has_key: boolean; provider: string | null; can_book: boolean; agent_on: boolean };
}

interface SlotInfo {
  time: string;
  starts_at: string;
  left: number;
  free: boolean;
}

type Tab = 'list' | 'new' | 'settings';
type Filter = 'live' | 'today' | 'past' | 'completed' | 'cancelled' | 'all';
type Trend = 'week' | 'month' | 'year';

const FILTERS: Filter[] = ['live', 'today', 'past', 'completed', 'cancelled', 'all'];
const TRENDS: Trend[] = ['week', 'month', 'year'];
const DAY_KEYS = ['1', '2', '3', '4', '5', '6', '0']; // Monday first

const field =
  'h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

/** YYYY-MM-DD of an instant on the business's own calendar. */
function dayKey(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    typeof at === 'string' ? new Date(at) : at,
  );
}

function clock(at: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
}

function longDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 text-xs text-muted-foreground">
      <span className="mb-1 block">{text}</span>
      {children}
    </label>
  );
}

const STATUS_STYLE: Record<Status, string> = {
  booked: 'border-sky-500/40 text-sky-300',
  completed: 'border-emerald-500/40 text-emerald-300',
  cancelled: 'border-red-500/40 text-red-300',
  no_show: 'border-amber-500/40 text-amber-300',
};

// ------------------------------------------------------------
// The page
// ------------------------------------------------------------

export function AppointmentsStudio() {
  const t = useTranslations('Appointments');
  const { canEditSettings } = useAuth();
  const { channels } = useChannels();
  const supabase = useMemo(() => createClient(), []);

  const channelsLoaded = !!channels;
  const list = useMemo(() => channels ?? [], [channels]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel = list.find((c) => c.id === channelId) ?? list[0] ?? null;
  const fromId = channel?.id ?? null;

  const [tab, setTab] = useState<Tab>('list');
  const [bundle, setBundle] = useState<SettingsBundle | null>(null);
  const [rows, setRows] = useState<Appointment[] | null>(null);

  const loadSettings = useCallback(async () => {
    if (!fromId) return;
    try {
      setBundle(await api<SettingsBundle>(`/api/appointments/settings?channel_id=${fromId}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [fromId]);

  const loadRows = useCallback(async () => {
    if (!fromId) return;
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('appointments')
      .select('*, contact:contacts(name, phone)')
      .eq('channel_id', fromId)
      .gte('starts_at', since)
      .order('starts_at', { ascending: true })
      .limit(5000);
    if (error) {
      toast.error(t('loadFailed'));
      setRows((prev) => prev ?? []);
      return;
    }
    setRows((data as Appointment[] | null) ?? []);
  }, [fromId, supabase, t]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSettings();
      void loadRows();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadSettings, loadRows]);

  const patchRow = useCallback((next: Appointment) => {
    setRows((prev) =>
      (prev ?? [])
        .map((r) => (r.id === next.id ? { ...r, ...next, contact: r.contact } : r))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    );
  }, []);

  const tz = bundle?.settings.timezone ?? 'Asia/Kolkata';
  const ready = !!bundle && bundle.settings.channel_id === fromId;

  return (
    <div className="min-w-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {!channelsLoaded ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : !fromId ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noNumber')}
        </p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-end gap-3">
            <Label text={t('number')}>
              <select
                className={cn(field, 'w-full sm:w-72')}
                value={fromId}
                onChange={(e) => {
                  // Each number has its own diary, contacts and settings.
                  setChannelId(e.target.value);
                  setBundle(null);
                  setRows(null);
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
            {ready && (
              <Badge
                variant="outline"
                className={cn(
                  'h-7 font-normal',
                  bundle.settings.enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-border text-muted-foreground',
                )}
              >
                {bundle.settings.enabled ? t('chatOn') : t('chatOff')}
              </Badge>
            )}
          </div>

          <div className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
            {(
              [
                ['list', t('tabList'), CalendarCheck],
                ['new', t('tabNew'), CalendarPlus],
                ['settings', t('tabSettings'), Settings2],
              ] as [Tab, string, typeof CalendarCheck][]
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
                  tab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {!ready ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : tab === 'list' ? (
              <ListTab rows={rows} tz={tz} channelId={fromId} onChanged={patchRow} horizon={bundle.settings.days_ahead} />
            ) : tab === 'new' ? (
              <NewTab
                channelId={fromId}
                tz={tz}
                bundle={bundle}
                onBooked={(a) => {
                  void loadRows();
                  setTab('list');
                  void a;
                }}
              />
            ) : (
              <SettingsTab key={fromId} bundle={bundle} canEdit={canEditSettings} onSaved={(s) => setBundle({ ...bundle, settings: s })} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Slot picker (shared by "new" and "move")
// ------------------------------------------------------------

function SlotPicker({
  channelId,
  date,
  ignoreId,
  value,
  onChange,
}: {
  channelId: string;
  date: string;
  ignoreId?: string;
  value: string | null;
  onChange: (time: string | null) => void;
}) {
  const t = useTranslations('Appointments');
  const [state, setState] = useState<{ key: string; slots: SlotInfo[] } | null>(null);
  const key = `${channelId}:${date}:${ignoreId ?? ''}`;

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    const k = `${channelId}:${date}:${ignoreId ?? ''}`;
    const qs = new URLSearchParams({ channel_id: channelId, date });
    if (ignoreId) qs.set('ignore', ignoreId);
    api<{ slots: SlotInfo[] }>(`/api/appointments/slots?${qs.toString()}`)
      .then((d) => {
        if (!cancelled) setState({ key: k, slots: d.slots });
      })
      .catch(() => {
        if (!cancelled) setState({ key: k, slots: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, date, ignoreId]);

  if (!date) return null;
  if (!state || state.key !== key) return <Loader2 className="size-4 animate-spin text-primary" />;
  if (state.slots.length === 0) return <p className="text-xs text-muted-foreground">{t('closedThatDay')}</p>;
  if (!state.slots.some((s) => s.free)) return <p className="text-xs text-amber-300">{t('noFreeSlots')}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {state.slots.map((s) => (
        <button
          key={s.time}
          type="button"
          disabled={!s.free}
          onClick={() => onChange(value === s.time ? null : s.time)}
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-xs',
            value === s.time
              ? 'border-primary bg-primary/20 text-foreground'
              : s.free
                ? 'border-border text-foreground hover:border-primary'
                : 'cursor-not-allowed border-border text-muted-foreground line-through opacity-50',
          )}
        >
          {s.time}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------
// Diary: filters, calendar, trend, list
// ------------------------------------------------------------

function ListTab({
  rows,
  tz,
  channelId,
  onChanged,
  horizon,
}: {
  rows: Appointment[] | null;
  tz: string;
  channelId: string;
  onChanged: (a: Appointment) => void;
  horizon: number;
}) {
  const t = useTranslations('Appointments');
  const [filter, setFilter] = useState<Filter>('live');
  const [day, setDay] = useState<string | null>(null);
  const [trend, setTrend] = useState<Trend>('week');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = dayKey(new Date(now), tz);
  const [month, setMonth] = useState(() => today.slice(0, 7));

  const all = useMemo(() => rows ?? [], [rows]);
  const keyed = useMemo(() => all.map((a) => ({ a, day: dayKey(a.starts_at, tz), at: Date.parse(a.starts_at) })), [all, tz]);

  const shown = useMemo(() => {
    let out = keyed;
    if (day) out = out.filter((r) => r.day === day);
    else if (filter === 'live') out = out.filter((r) => r.a.status === 'booked' && (r.at > now || r.day === today));
    else if (filter === 'today') out = out.filter((r) => r.day === today && r.a.status !== 'cancelled');
    else if (filter === 'past') out = out.filter((r) => r.at <= now && r.day !== today);
    else if (filter === 'completed') out = out.filter((r) => r.a.status === 'completed');
    else if (filter === 'cancelled') out = out.filter((r) => r.a.status === 'cancelled');
    const newestFirst = !day && (filter === 'past' || filter === 'completed' || filter === 'cancelled' || filter === 'all');
    return [...out].sort((x, y) => (newestFirst ? y.at - x.at : x.at - y.at)).slice(0, 300);
  }, [keyed, day, filter, now, today]);

  // Calendar month: how many (not cancelled) appointments each day has.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of keyed) if (r.a.status !== 'cancelled') m.set(r.day, (m.get(r.day) ?? 0) + 1);
    return m;
  }, [keyed]);
  const cells = useMemo(() => {
    const [y, mo] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const out: (string | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
    return out;
  }, [month]);
  const moveMonth = (delta: number) => {
    const [y, mo] = month.split('-').map(Number);
    setMonth(new Date(Date.UTC(y, mo - 1 + delta, 1)).toISOString().slice(0, 7));
  };
  const monthTitle = useMemo(() => {
    const [y, mo] = month.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
      new Date(Date.UTC(y, mo - 1, 1)),
    );
  }, [month]);
  const weekdayNames = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(Date.UTC(2024, 0, 1 + i))),
      ),
    [],
  );

  // Trend: appointments per week / month / year (cancelled left out).
  const bars = useMemo(() => {
    const buckets: { label: string; from: string; to: string }[] = [];
    if (trend === 'week') {
      const [y, m, d] = today.split('-').map(Number);
      const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      const monday = shiftDay(today, -dow);
      for (let i = 7; i >= -1; i--) {
        const from = shiftDay(monday, -7 * i);
        buckets.push({ label: from.slice(5).replace('-', '/'), from, to: shiftDay(from, 6) });
      }
    } else if (trend === 'month') {
      const [y, m] = today.split('-').map(Number);
      for (let i = 10; i >= -1; i--) {
        const start = new Date(Date.UTC(y, m - 1 - i, 1));
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
        buckets.push({
          label: new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short' }).format(start),
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
        });
      }
    } else {
      const y = Number(today.slice(0, 4));
      for (let i = 1; i >= 0; i--) buckets.push({ label: String(y - i), from: `${y - i}-01-01`, to: `${y - i}-12-31` });
      buckets.push({ label: String(y + 1), from: `${y + 1}-01-01`, to: `${y + 1}-12-31` });
    }
    const out = buckets.map((b) => ({
      ...b,
      count: keyed.filter((r) => r.a.status !== 'cancelled' && r.day >= b.from && r.day <= b.to).length,
      current: today >= b.from && today <= b.to,
    }));
    const max = Math.max(1, ...out.map((b) => b.count));
    return out.map((b) => ({ ...b, pct: Math.round((b.count / max) * 100) }));
  }, [keyed, trend, today]);

  const liveCount = keyed.filter((r) => r.a.status === 'booked' && r.at > now).length;
  const todayCount = keyed.filter((r) => r.day === today && r.a.status !== 'cancelled').length;

  if (rows === null) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)] xl:items-start">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f);
                setDay(null);
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                !day && filter === f
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`filter.${f}`)}
              {f === 'live' ? ` (${liveCount})` : f === 'today' ? ` (${todayCount})` : ''}
            </button>
          ))}
          {day && (
            <Badge variant="outline" className="gap-1 border-primary font-normal">
              {longDay(day)}
              <button type="button" aria-label={t('clearDay')} onClick={() => setDay(null)}>
                <X className="size-3" />
              </button>
            </Badge>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {shown.map(({ a, day: d, at }) => (
              <AppointmentCard
                key={a.id}
                a={a}
                dayLabel={longDay(d)}
                tz={tz}
                isPast={at <= now}
                channelId={channelId}
                today={today}
                horizon={horizon}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0 space-y-4">
        <Section title={t('calendar')}>
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => moveMonth(-1)} aria-label={t('prevMonth')}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm font-medium">{monthTitle}</span>
            <Button variant="outline" size="sm" onClick={() => moveMonth(1)} aria-label={t('nextMonth')}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
            {weekdayNames.map((n, i) => (
              <span key={i}>{n}</span>
            ))}
            {cells.map((c, i) =>
              c ? (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDay(day === c ? null : c)}
                  className={cn(
                    'flex aspect-square flex-col items-center justify-center rounded-md border text-xs',
                    day === c
                      ? 'border-primary bg-primary/20 text-foreground'
                      : c === today
                        ? 'border-primary/60 text-foreground'
                        : 'border-transparent text-foreground hover:border-border',
                  )}
                >
                  {Number(c.slice(8))}
                  {(counts.get(c) ?? 0) > 0 && (
                    <span className="mt-0.5 rounded-full bg-primary/30 px-1 text-[10px] leading-4">{counts.get(c)}</span>
                  )}
                </button>
              ) : (
                <span key={`e${i}`} />
              ),
            )}
          </div>
        </Section>

        <Section title={t('trend')} hint={t('trendHint')}>
          <div className="flex gap-1.5">
            {TRENDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTrend(k)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs',
                  trend === k
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`trendBy.${k}`)}
              </button>
            ))}
          </div>
          <div className="flex h-32 items-end gap-1.5">
            {bars.map((b) => (
              <div key={b.from} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[10px] text-muted-foreground">{b.count}</span>
                <div
                  className={cn('w-full rounded-t', b.current ? 'bg-primary' : 'bg-primary/40')}
                  style={{ height: `${Math.max(b.count ? 6 : 1, b.pct * 0.7)}%` }}
                />
                <span className="w-full truncate text-center text-[10px] text-muted-foreground">{b.label}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function AppointmentCard({
  a,
  dayLabel,
  tz,
  isPast,
  channelId,
  today,
  horizon,
  onChanged,
}: {
  a: Appointment;
  dayLabel: string;
  tz: string;
  isPast: boolean;
  channelId: string;
  today: string;
  horizon: number;
  onChanged: (a: Appointment) => void;
}) {
  const t = useTranslations('Appointments');
  const [mode, setMode] = useState<'complete' | 'move' | 'notes' | null>(null);
  const [busy, setBusy] = useState(false);
  const [treatment, setTreatment] = useState(a.treatment ?? '');
  const [medicine, setMedicine] = useState(a.medicine ?? '');
  const [notes, setNotes] = useState(a.notes ?? '');
  const [moveDate, setMoveDate] = useState('');
  const [moveTime, setMoveTime] = useState<string | null>(null);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const res = await api<{ appointment: Appointment; message_error: string | null }>(`/api/appointments/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onChanged(res.appointment);
      setMode(null);
      toast.success(done);
      if (res.message_error) toast.error(t('messageNotSent', { error: res.message_error }), { duration: 9000 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setBusy(false);
    }
  };

  const name = a.customer_name || a.contact?.name || a.contact?.phone || a.phone_key;
  return (
    <li className="min-w-0 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="text-xs text-muted-foreground">
            {dayLabel} · {clock(a.starts_at, tz)}
            {a.contact?.phone ? ` · ${a.contact.phone}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={cn('font-normal', STATUS_STYLE[a.status])}>
            {t(`status.${a.status}`)}
          </Badge>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {a.source === 'ai' ? t('sourceAi') : t('sourcePortal')}
          </Badge>
        </div>
      </div>

      {(a.treatment || a.medicine || a.notes) && mode !== 'complete' && mode !== 'notes' && (
        <div className="mt-2 space-y-0.5 break-words text-xs text-muted-foreground">
          {a.treatment && <p>{t('treatment')}: <span className="text-foreground">{a.treatment}</span></p>}
          {a.medicine && <p>{t('medicine')}: <span className="text-foreground">{a.medicine}</span></p>}
          {a.notes && <p>{t('notes')}: <span className="text-foreground">{a.notes}</span></p>}
        </div>
      )}
      {a.status === 'booked' && !isPast && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {a.reminder_error
            ? t('reminderFailed', { error: a.reminder_error })
            : a.reminder_sent_at
              ? t('reminderSent')
              : a.reminder_at
                ? t('reminderDue', { when: `${longDay(dayKey(a.reminder_at, tz))} · ${clock(a.reminder_at, tz)}` })
                : t('reminderNone')}
        </p>
      )}

      {mode === null && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {a.status === 'booked' && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('complete')}>
                <CheckCircle2 className="size-4" />
                {t('complete')}
              </Button>
              {!isPast && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('move')}>
                  {t('move')}
                </Button>
              )}
              {isPast && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'no_show' }, t('saved'))}>
                  {t('noShow')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (confirm(isPast ? t('cancelConfirmPast') : t('cancelConfirm'))) void act({ action: 'cancel' }, t('cancelled'));
                }}
              >
                {t('cancel')}
              </Button>
            </>
          )}
          {(a.status === 'completed' || a.status === 'no_show') && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('notes')}>
                {t('editNotes')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'reopen' }, t('saved'))}>
                {t('reopen')}
              </Button>
            </>
          )}
        </div>
      )}

      {(mode === 'complete' || mode === 'notes') && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t('notesHint')}</p>
          <Label text={t('treatment')}>
            <Textarea rows={2} className="bg-muted" value={treatment} onChange={(e) => setTreatment(e.target.value)} />
          </Label>
          <Label text={t('medicine')}>
            <Textarea rows={2} className="bg-muted" value={medicine} onChange={(e) => setMedicine(e.target.value)} />
          </Label>
          <Label text={t('notes')}>
            <Textarea rows={2} className="bg-muted" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Label>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  { action: mode === 'complete' ? 'complete' : 'notes', treatment, medicine, notes },
                  mode === 'complete' ? t('completed') : t('saved'),
                )
              }
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {mode === 'complete' ? t('markCompleted') : t('save')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(null)}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'move' && (
        <div className="mt-3 space-y-2">
          <Label text={t('newDate')}>
            <input
              type="date"
              className={field}
              min={today}
              max={shiftDay(today, horizon)}
              value={moveDate}
              onChange={(e) => {
                setMoveDate(e.target.value);
                setMoveTime(null);
              }}
            />
          </Label>
          <SlotPicker channelId={channelId} date={moveDate} ignoreId={a.id} value={moveTime} onChange={setMoveTime} />
          <p className="text-xs text-muted-foreground">{t('moveHint')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !moveDate || !moveTime}
              onClick={() => void act({ action: 'reschedule', date: moveDate, time: moveTime }, t('moved'))}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('moveConfirm')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(null)}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------
// New appointment from the portal
// ------------------------------------------------------------

interface ContactHit {
  id: string;
  name: string | null;
  phone: string | null;
}

function NewTab({
  channelId,
  tz,
  bundle,
  onBooked,
}: {
  channelId: string;
  tz: string;
  bundle: SettingsBundle;
  onBooked: (a: Appointment) => void;
}) {
  const t = useTranslations('Appointments');
  const supabase = useMemo(() => createClient(), []);
  const today = dayKey(new Date(), tz);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [contact, setContact] = useState<ContactHit | null>(null);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only this number's own contacts: people who have a chat on it.
  useEffect(() => {
    const term = query.trim();
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        let q = supabase
          .from('contacts')
          .select('id, name, phone, conversations!inner(channel_id)')
          .eq('conversations.channel_id', channelId)
          .not('phone', 'is', null);
        const filter = term.length >= 2 ? contactSearchFilter(term) : null;
        if (filter) q = q.or(filter);
        const { data } = await q.order('name').limit(50);
        if (cancelled) return;
        setHits(((data as ContactHit[] | null) ?? []).map((c) => ({ id: c.id, name: c.name, phone: c.phone })));
      },
      term ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, supabase, channelId]);

  const book = async () => {
    if (!contact || !date || !time) return;
    setBusy(true);
    try {
      const res = await api<{ appointment: Appointment; message_error: string | null }>('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, contact_id: contact.id, date, time }),
      });
      if (res.message_error) toast.error(t('bookedNotSent', { error: res.message_error }), { duration: 10000 });
      else toast.success(t('bookedSent'));
      onBooked(res.appointment);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 9000 });
    } finally {
      setBusy(false);
    }
  };

  if (!bundle.settings.id) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {t('saveSettingsFirst')}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      <Section title={t('pickContact')} hint={t('pickContactHint')}>
        {contact ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-primary bg-primary/10 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{contact.name || contact.phone}</p>
              <p className="text-xs text-muted-foreground">{contact.phone}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setContact(null)}>
              {t('change')}
            </Button>
          </div>
        ) : (
          <>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('contactSearch')} className="bg-muted" />
            {hits.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noContacts')}</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto rounded-lg border border-border">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => setContact(h)}
                    >
                      <span className="truncate">{h.name || h.phone}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{h.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title={t('pickSlot')} hint={t('pickSlotHint')}>
        <Label text={t('date')}>
          <input
            type="date"
            className={field}
            min={today}
            max={shiftDay(today, bundle.settings.days_ahead)}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setTime(null);
            }}
          />
        </Label>
        <SlotPicker channelId={channelId} date={date} value={time} onChange={setTime} />
        <Button disabled={busy || !contact || !date || !time} onClick={() => void book()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />}
          {t('bookAndSend')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('oneLiveRule')}</p>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

function SettingsTab({
  bundle,
  canEdit,
  onSaved,
}: {
  bundle: SettingsBundle;
  canEdit: boolean;
  onSaved: (s: AppointmentSettings) => void;
}) {
  const t = useTranslations('Appointments');
  const [s, setS] = useState<AppointmentSettings>(bundle.settings);
  const [saving, setSaving] = useState(false);
  const [holiday, setHoliday] = useState('');
  const set = <K extends keyof AppointmentSettings>(key: K, value: AppointmentSettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const zones = useMemo(() => {
    try {
      const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
      return all.includes(s.timezone) ? all : [s.timezone, ...all];
    } catch {
      return [s.timezone];
    }
  }, [s.timezone]);
  const dayNames = useMemo(
    () =>
      Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          String(i),
          new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'long' }).format(new Date(Date.UTC(2024, 0, 7 + i))),
        ]),
      ) as Record<string, string>,
    [],
  );

  const setRanges = (day: string, ranges: HoursRange[]) => {
    const next = { ...s.hours };
    if (ranges.length === 0) delete next[day];
    else next[day] = ranges;
    set('hours', next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<{ settings: AppointmentSettings }>('/api/appointments/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      setS(res.settings);
      onSaved(res.settings);
      toast.success(t('settingsSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const templateValue = (name: string | null, lang: string | null) => (name ? `${name}|${lang ?? 'en_US'}` : '');
  const off = !canEdit;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      <div className="min-w-0 space-y-4">
        <Section title={t('chatBooking')} hint={t('chatBookingHint')}>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={s.enabled}
              disabled={off}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>
              {t('enable')}
              <span className="block text-xs text-muted-foreground">{t('chainHint')}</span>
            </span>
          </label>
          {!bundle.ai.has_key ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">{t('aiNoKey')}</p>
          ) : !bundle.ai.can_book ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              {t('aiWrongProvider', { provider: bundle.ai.provider ?? '' })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{bundle.ai.agent_on ? t('aiAgentOn') : t('aiAgentOff')}</p>
          )}
        </Section>

        <Section title={t('business')}>
          <Label text={t('businessName')}>
            <Input className="bg-muted" disabled={off} value={s.business_name ?? ''} onChange={(e) => set('business_name', e.target.value)} placeholder={t('businessNameExample')} />
          </Label>
          <Label text={t('address')}>
            <Textarea rows={2} className="bg-muted" disabled={off} value={s.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Label>
          <Label text={t('timezone')}>
            <select className={cn(field, 'w-full')} disabled={off} value={s.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Label>
        </Section>

        <Section title={t('slots')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Label text={t('slotMinutes')}>
              <input type="number" min={5} max={480} step={5} className={cn(field, 'w-full')} disabled={off} value={s.slot_minutes} onChange={(e) => set('slot_minutes', Number(e.target.value))} />
            </Label>
            <Label text={t('slotCapacity')}>
              <input type="number" min={1} max={100} className={cn(field, 'w-full')} disabled={off} value={s.slot_capacity} onChange={(e) => set('slot_capacity', Number(e.target.value))} />
            </Label>
            <Label text={t('daysAhead')}>
              <input type="number" min={1} max={365} className={cn(field, 'w-full')} disabled={off} value={s.days_ahead} onChange={(e) => set('days_ahead', Number(e.target.value))} />
            </Label>
          </div>
        </Section>

        <Section title={t('reminder')} hint={t('reminderHint')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Label text={t('reminderWhen')}>
              <select className={cn(field, 'w-full')} disabled={off} value={s.reminder_mode} onChange={(e) => set('reminder_mode', e.target.value as ReminderMode)}>
                <option value="same_day">{t('reminderMode.same_day')}</option>
                <option value="day_before">{t('reminderMode.day_before')}</option>
                <option value="none">{t('reminderMode.none')}</option>
              </select>
            </Label>
            <Label text={t('reminderTime')}>
              <input type="time" className={cn(field, 'w-full')} disabled={off || s.reminder_mode === 'none'} value={s.reminder_time} onChange={(e) => set('reminder_time', e.target.value)} />
            </Label>
          </div>
        </Section>
      </div>

      <div className="min-w-0 space-y-4">
        <Section title={t('hours')} hint={t('hoursHint')}>
          {DAY_KEYS.map((day) => {
            const ranges = s.hours[day] ?? [];
            return (
              <div key={day} className="flex flex-wrap items-center gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                <label className="flex w-28 shrink-0 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    disabled={off}
                    checked={ranges.length > 0}
                    onChange={(e) => setRanges(day, e.target.checked ? [['10:00', '18:00']] : [])}
                  />
                  {dayNames[day]}
                </label>
                {ranges.length === 0 ? (
                  <span className="text-xs text-muted-foreground">{t('closed')}</span>
                ) : (
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {ranges.map((r, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-1.5">
                        <input type="time" className={cn(field, 'w-[6.75rem] px-1.5')} disabled={off} value={r[0]} onChange={(e) => setRanges(day, ranges.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                        <span className="text-xs text-muted-foreground">–</span>
                        <input type="time" className={cn(field, 'w-[6.75rem] px-1.5')} disabled={off} value={r[1]} onChange={(e) => setRanges(day, ranges.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                        {ranges.length > 1 && (
                          <button type="button" disabled={off} aria-label={t('removeRange')} onClick={() => setRanges(day, ranges.filter((_, j) => j !== i))}>
                            <Trash2 className="size-4 text-muted-foreground hover:text-foreground" />
                          </button>
                        )}
                        {i === ranges.length - 1 && ranges.length < 3 && (
                          <button
                            type="button"
                            disabled={off}
                            className="flex items-center gap-1 text-xs text-primary"
                            onClick={() => setRanges(day, [...ranges, [r[1], r[1]]])}
                          >
                            <Plus className="size-3" />
                            {t('addBreak')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Section>

        <Section title={t('holidays')} hint={t('holidaysHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" className={field} disabled={off} value={holiday} onChange={(e) => setHoliday(e.target.value)} />
            <Button
              size="sm"
              variant="outline"
              disabled={off || !holiday || s.holidays.includes(holiday)}
              onClick={() => {
                set('holidays', [...s.holidays, holiday].sort());
                setHoliday('');
              }}
            >
              {t('addHoliday')}
            </Button>
          </div>
          {s.holidays.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.holidays.map((d) => (
                <Badge key={d} variant="outline" className="gap-1 font-normal">
                  {longDay(d)}
                  <button type="button" disabled={off} aria-label={t('removeHoliday')} onClick={() => set('holidays', s.holidays.filter((x) => x !== d))}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </Section>

        {bundle.provider === 'meta' && (
          <Section title={t('templates')} hint={t('templatesHint')}>
            {(['confirm', 'reminder'] as const).map((kind) => {
              const nameKey = kind === 'confirm' ? 'confirm_template' : 'reminder_template';
              const langKey = kind === 'confirm' ? 'confirm_template_language' : 'reminder_template_language';
              return (
                <div key={kind} className="space-y-1.5">
                  <Label text={t(kind === 'confirm' ? 'confirmTemplate' : 'reminderTemplate')}>
                    <select
                      className={cn(field, 'w-full')}
                      disabled={off}
                      value={templateValue(s[nameKey], s[langKey])}
                      onChange={(e) => {
                        const [name, lang] = e.target.value.split('|');
                        setS((prev) => ({ ...prev, [nameKey]: name || null, [langKey]: name ? lang || 'en_US' : null }));
                      }}
                    >
                      <option value="">{t('noTemplate')}</option>
                      {s[nameKey] && !bundle.templates.some((x) => x.name === s[nameKey] && x.language === (s[langKey] ?? 'en_US')) && (
                        <option value={templateValue(s[nameKey], s[langKey])}>{s[nameKey]}</option>
                      )}
                      {bundle.templates.map((x) => (
                        <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>
                          {x.name} ({x.language})
                        </option>
                      ))}
                    </select>
                  </Label>
                  <p className="text-[11px] text-muted-foreground">{t('templateExample')}</p>
                  <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-[11px] text-foreground">
                    {bundle.template_examples[kind]}
                  </p>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t('templateValues')}</p>
          </Section>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} disabled={off || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('saveSettings')}
          </Button>
          {off && <span className="text-xs text-muted-foreground">{t('adminOnly')}</span>}
        </div>
      </div>
    </div>
  );
}
