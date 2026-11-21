'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CalendarCheck,
  CalendarPlus,
  Camera,
  CheckCircle2,
  ExternalLink,
  FileText,
  Paperclip,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  Phone,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { contactSearchFilter } from '@/lib/contacts/search-filter';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { REPLY_LANGUAGES, type AppointmentSettings, type HoursRange, type ReminderMode } from '@/lib/appointments/time';
import { MEDIA_MAX_BYTES, uploadAccountMedia } from '@/lib/storage/upload-media';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useIsMobile, useKeyedPage, usePageSize } from '@/hooks/use-page-size';
import { ListPager } from '@/components/ui/list-pager';
import { TrendBars } from './trend-bars';

// ------------------------------------------------------------
// Shapes
// ------------------------------------------------------------

type Status = 'pending' | 'booked' | 'completed' | 'cancelled' | 'no_show';

interface Appointment {
  id: string;
  channel_id: string;
  contact_id: string;
  conversation_id?: string | null;
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
  attachments?: Attachment[] | null;
  details?: { requirements?: string | null; address?: string | null; answers?: { q: string; a: string }[] } | null;
  contact?: { name: string | null; phone: string | null } | null;
}

interface Attachment {
  url: string;
  name: string;
  mime: string;
}

const MAX_FILES = 5;
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

interface DayInfo {
  date: string;
  open: boolean;
  free: number;
}

interface SettingsBundle {
  settings: AppointmentSettings;
  provider: 'meta' | 'waha';
  templates: { name: string; language: string }[];
  template_examples: { confirm: string; reminder: string };
  ai: { has_key: boolean; provider: string | null; model: string | null; can_book: boolean; agent_on: boolean };
}

interface SlotInfo {
  time: string;
  starts_at: string;
  left: number;
  free: boolean;
}

type Tab = 'list' | 'new' | 'settings';
type Filter = 'pending' | 'live' | 'today' | 'past' | 'completed' | 'no_show' | 'cancelled' | 'all';
type Trend = 'week' | 'month' | 'year';

const FILTERS: Filter[] = ['pending', 'live', 'today', 'past', 'completed', 'no_show', 'cancelled', 'all'];
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

const PROVIDER_NAMES: Record<string, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI-compatible',
};

const STATUS_STYLE: Record<Status, string> = {
  pending: 'border-violet-500/50 text-violet-300',
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
  const { canEditSettings, canSendMessages } = useAuth();
  const { channels } = useChannels();
  const supabase = useMemo(() => createClient(), []);

  const channelsLoaded = !!channels;
  const list = useMemo(() => channels ?? [], [channels]);
  // A link from the dashboard calendar can name the number (?channel=).
  const [channelId, setChannelId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('channel'),
  );
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
    const { data, error } = await supabase
      .from('appointments')
      .select('*, contact:contacts(name, phone)')
      .eq('channel_id', fromId)
      .order('starts_at', { ascending: false })
      .limit(10000);
    if (error) {
      toast.error(t('loadFailed'));
      setRows((prev) => prev ?? []);
      return;
    }
    setRows(((data as Appointment[] | null) ?? []).reverse());
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
                ...(canSendMessages ? ([['new', t('tabNew'), CalendarPlus]] as [Tab, string, typeof CalendarCheck][]) : []),
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
              <ListTab rows={rows} tz={tz} channelId={fromId} onChanged={patchRow} onReload={loadRows} />
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
              <SettingsTab
                key={fromId}
                bundle={bundle}
                canEdit={canEditSettings}
                onSaved={(s) => setBundle({ ...bundle, settings: s })}
                onAiChanged={loadSettings}
              />
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
  // Only times that can really be booked: taken and past ones are left out.
  const free = state.slots.filter((s) => s.free);
  if (free.length === 0) return <p className="text-xs text-amber-300">{t('noFreeSlots')}</p>;
  return (
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
      {free.map((s) => (
        <button
          key={s.time}
          type="button"
          onClick={() => onChange(value === s.time ? null : s.time)}
          className={cn(
            'rounded-md border px-1 py-2 text-xs',
            value === s.time
              ? 'border-primary bg-primary/20 text-foreground'
              : 'border-border text-foreground hover:border-primary',
          )}
        >
          {s.time}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------
// Date picker: only days that still have a free slot can be chosen.
// Closed weekdays, closed dates, full days and past days are greyed out.
// ------------------------------------------------------------

function DayPicker({
  channelId,
  ignoreId,
  value,
  onChange,
}: {
  channelId: string;
  ignoreId?: string;
  value: string;
  onChange: (date: string) => void;
}) {
  const t = useTranslations('Appointments');
  const [month, setMonth] = useState(() => (value || new Date().toISOString().slice(0, 10)).slice(0, 7));
  const [state, setState] = useState<{ key: string; days: DayInfo[]; today: string } | null>(null);
  const key = `${channelId}:${month}:${ignoreId ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    const k = `${channelId}:${month}:${ignoreId ?? ''}`;
    const qs = new URLSearchParams({ channel_id: channelId, month });
    if (ignoreId) qs.set('ignore', ignoreId);
    api<{ days: DayInfo[]; today: string }>(`/api/appointments/days?${qs.toString()}`)
      .then((d) => {
        if (!cancelled) setState({ key: k, days: d.days, today: d.today });
      })
      .catch(() => {
        if (!cancelled) setState({ key: k, days: [], today: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, month, ignoreId]);

  const loaded = state && state.key === key ? state : null;
  const byDate = useMemo(() => new Map((loaded?.days ?? []).map((d) => [d.date, d])), [loaded]);
  const [y, mo] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= count; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  const title = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, mo - 1, 1)),
  );
  const move = (delta: number) => setMonth(new Date(Date.UTC(y, mo - 1 + delta, 1)).toISOString().slice(0, 7));
  const atFirstMonth = !!state?.today && month <= state.today.slice(0, 7);

  return (
    <div className="w-full max-w-xs rounded-lg border border-border p-2">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={atFirstMonth} onClick={() => move(-1)} aria-label={t('prevMonth')}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-sm font-medium">{title}</span>
        <Button variant="outline" size="sm" onClick={() => move(1)} aria-label={t('nextMonth')}>
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i}>
            {new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(Date.UTC(2024, 0, 1 + i)))}
          </span>
        ))}
        {cells.map((c, i) => {
          if (!c) return <span key={`e${i}`} />;
          const info = byDate.get(c);
          const can = !!info && info.free > 0;
          return (
            <button
              key={c}
              type="button"
              disabled={!can}
              title={!info ? '' : !info.open ? t('dayClosed') : info.free === 0 ? t('dayFull') : t('dayFree', { count: info.free })}
              onClick={() => onChange(c)}
              className={cn(
                'flex aspect-square items-center justify-center rounded-md border text-xs',
                value === c
                  ? 'border-primary bg-primary/25 font-semibold text-foreground'
                  : can
                    ? 'border-border text-foreground hover:border-primary'
                    : 'cursor-not-allowed border-transparent text-muted-foreground/50 line-through',
              )}
            >
              {Number(c.slice(8))}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{loaded ? t('dayPickerHint') : t('loadingDays')}</p>
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
  onReload,
}: {
  rows: Appointment[] | null;
  tz: string;
  channelId: string;
  onChanged: (a: Appointment) => void;
  onReload: () => void | Promise<void>;
}) {
  const t = useTranslations('Appointments');
  const [filter, setFilter] = useState<Filter>('live');
  // ...and the day to show (?day=YYYY-MM-DD).
  const [day, setDay] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const asked = new URLSearchParams(window.location.search).get('day') ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;
  });
  const [trend, setTrend] = useState<Trend>('week');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = dayKey(new Date(now), tz);
  const [month, setMonth] = useState(() => (day ?? today).slice(0, 7));
  const isMobile = useIsMobile();
  const pageSize = usePageSize();
  const [pageRaw, setPage] = useKeyedPage(`${filter}|${day ?? ''}`);

  const all = useMemo(() => rows ?? [], [rows]);
  const keyed = useMemo(() => all.map((a) => ({ a, day: dayKey(a.starts_at, tz), at: Date.parse(a.starts_at) })), [all, tz]);

  const shown = useMemo(() => {
    let out = keyed;
    if (day) out = out.filter((r) => r.day === day);
    else if (filter === 'pending') out = out.filter((r) => r.a.status === 'pending');
    else if (filter === 'live')
      out = out.filter((r) => (r.a.status === 'booked' || r.a.status === 'pending') && (r.at > now || r.day === today));
    else if (filter === 'today') out = out.filter((r) => r.day === today && r.a.status !== 'cancelled');
    else if (filter === 'past') out = out.filter((r) => r.at <= now && r.day !== today);
    else if (filter === 'completed') out = out.filter((r) => r.a.status === 'completed');
    else if (filter === 'no_show') out = out.filter((r) => r.a.status === 'no_show');
    else if (filter === 'cancelled') out = out.filter((r) => r.a.status === 'cancelled');
    // On a phone the list is always latest first. On a bigger screen
    // upcoming ones read soonest first, history latest first.
    const newestFirst =
      isMobile ||
      (!day && (filter === 'past' || filter === 'completed' || filter === 'no_show' || filter === 'cancelled' || filter === 'all'));
    return [...out].sort((x, y) => (newestFirst ? y.at - x.at : x.at - y.at));
  }, [keyed, day, filter, now, today, isMobile]);
  const page = Math.min(pageRaw, Math.max(0, Math.ceil(shown.length / pageSize) - 1));
  const paged = shown.slice(page * pageSize, (page + 1) * pageSize);

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
  const monthNames = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short' }).format(new Date(Date.UTC(2024, i, 1))),
      ),
    [],
  );
  // From the first appointment on record (at least five years back) to
  // three years ahead, and always the year being looked at.
  const years = useMemo(() => {
    const thisYear = Number(today.slice(0, 4));
    const firstYear = Math.min(thisYear - 5, ...keyed.map((r) => Number(r.day.slice(0, 4))), Number(month.slice(0, 4)));
    const lastYear = Math.max(thisYear + 3, Number(month.slice(0, 4)));
    return Array.from({ length: lastYear - firstYear + 1 }, (_, i) => String(firstYear + i));
  }, [today, keyed, month]);
  const weekdayNames = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(Date.UTC(2024, 0, 1 + i))),
      ),
    [],
  );

  // Trend: appointments per week / month / year (cancelled left out).
  const trendBuckets = useMemo(() => {
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
    return buckets.map((x) => ({ ...x, key: x.from }));
  }, [trend, today]);
  const trendPoints = useMemo(
    () => keyed.map((r) => ({ day: r.day, at: r.at, status: r.a.status })),
    [keyed],
  );

  const liveCount = keyed.filter((r) => (r.a.status === 'booked' || r.a.status === 'pending') && r.at > now).length;
  const pendingCount = keyed.filter((r) => r.a.status === 'pending').length;
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
      <div className="order-2 min-w-0 space-y-3 xl:order-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.filter((f) => f !== 'pending' || pendingCount > 0 || filter === 'pending').map((f) => (
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
                  : f === 'pending'
                    ? 'border-violet-500/60 text-violet-300'
                    : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`filter.${f}`)}
              {f === 'live' ? ` (${liveCount})` : f === 'today' ? ` (${todayCount})` : f === 'pending' ? ` (${pendingCount})` : ''}
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
          <>
          <ListPager page={page} pageSize={pageSize} total={shown.length} onChange={setPage} />
          <ul className="space-y-2">
            {paged.map(({ a, day: d, at }) => (
              <AppointmentCard
                key={a.id}
                a={a}
                dayLabel={longDay(d)}
                tz={tz}
                isPast={at <= now}
                channelId={channelId}
                onChanged={onChanged}
                onReload={onReload}
              />
            ))}
          </ul>
          <ListPager page={page} pageSize={pageSize} total={shown.length} onChange={setPage} />
          </>
        )}
      </div>

      {/* On a phone this wrapper disappears (display: contents) so the
          calendar can sit above the list and the trend below it. */}
      <div className="contents xl:order-2 xl:block xl:min-w-0 xl:space-y-4">
        <div className="order-1 min-w-0 xl:order-none">
        <Section title={t('calendar')}>
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => moveMonth(-1)} aria-label={t('prevMonth')}>
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex min-w-0 items-center gap-1.5">
              <select
                aria-label={t('month')}
                className={cn(field, 'h-8 px-1')}
                value={month.slice(5)}
                onChange={(e) => setMonth(`${month.slice(0, 4)}-${e.target.value}`)}
              >
                {monthNames.map((name, i) => (
                  <option key={name} value={String(i + 1).padStart(2, '0')}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('year')}
                className={cn(field, 'h-8 px-1')}
                value={month.slice(0, 4)}
                onChange={(e) => setMonth(`${e.target.value}-${month.slice(5)}`)}
              >
                {years.map((yr) => (
                  <option key={yr} value={yr}>
                    {yr}
                  </option>
                ))}
              </select>
            </div>
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
        </div>

        <div className="order-3 min-w-0 xl:order-none">
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
          <TrendBars points={trendPoints} buckets={trendBuckets} today={today} nowMs={now} />
        </Section>
        </div>
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
  onChanged,
  onReload,
}: {
  a: Appointment;
  dayLabel: string;
  tz: string;
  isPast: boolean;
  channelId: string;
  onChanged: (a: Appointment) => void;
  onReload: () => void | Promise<void>;
}) {
  const t = useTranslations('Appointments');
  const [mode, setMode] = useState<'complete' | 'move' | 'notes' | 'confirmMove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [treatment, setTreatment] = useState(a.treatment ?? '');
  const [medicine, setMedicine] = useState(a.medicine ?? '');
  const [notes, setNotes] = useState(a.notes ?? '');
  const [moveDate, setMoveDate] = useState('');
  const [moveTime, setMoveTime] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>(a.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [nextOn, setNextOn] = useState(false);
  const [nextDate, setNextDate] = useState('');
  const [nextTime, setNextTime] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [openingChat, setOpeningChat] = useState(false);
  // Viewers read; only agents and above act on an appointment.
  const { canSendMessages } = useAuth();
  const readOnly = !canSendMessages;

  // Straight to this customer's chat on this number, to write to them.
  const openChat = async () => {
    setOpeningChat(true);
    try {
      let id = a.conversation_id ?? null;
      if (!id) {
        const { data } = await createClient()
          .from('conversations')
          .select('id')
          .eq('contact_id', a.contact_id)
          .eq('channel_id', a.channel_id)
          .limit(1);
        id = (data as { id: string }[] | null)?.[0]?.id ?? null;
      }
      if (id) router.push(`/inbox?c=${id}`);
      else toast.error(t('noChat'));
    } finally {
      setOpeningChat(false);
    }
  };

  const addFiles = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const room = MAX_FILES - files.length;
    if (picked.length > room) toast.error(t('tooManyFiles', { max: MAX_FILES }));
    const batch = Array.from(picked).slice(0, Math.max(0, room));
    if (batch.length === 0) return;
    setUploading(true);
    try {
      for (const file of batch) {
        if (!FILE_TYPES.includes(file.type)) {
          toast.error(t('fileType', { name: file.name }));
          continue;
        }
        if (file.size > MEDIA_MAX_BYTES) {
          toast.error(t('fileTooLarge', { name: file.name }));
          continue;
        }
        try {
          const up = await uploadAccountMedia('chat-media', file);
          setFiles((prev) =>
            prev.length >= MAX_FILES ? prev : [...prev, { url: up.publicUrl, name: file.name, mime: file.type }],
          );
        } catch (err) {
          toast.error(t('uploadFailed', { error: err instanceof Error ? err.message : String(err) }));
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  };

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const res = await api<{
        appointment: Appointment;
        message_error: string | null;
        next_appointment?: Appointment | null;
        next_error?: string | null;
      }>(`/api/appointments/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onChanged(res.appointment);
      setMode(null);
      toast.success(done);
      if (res.next_appointment) {
        toast.success(t('nextVisitBooked'));
        void onReload();
      }
      if (res.next_error) toast.error(t('nextVisitFailed', { error: res.next_error }), { duration: 10000 });
      if (res.message_error) toast.error(t('messageNotSent', { error: res.message_error }), { duration: 9000 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setBusy(false);
    }
  };

  const name = a.customer_name || a.contact?.name || a.contact?.phone || a.phone_key;
  const callDigits = (a.contact?.phone ?? '').replace(/\D/g, '');
  const callNumber = callDigits.length >= 10 ? `+${callDigits}` : '';
  return (
    <li className="min-w-0 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-foreground">{name}</p>
          <p className="text-xs text-muted-foreground">
            <span className="whitespace-nowrap">{dayLabel}</span>
            {' · '}
            <span className="whitespace-nowrap">{clock(a.starts_at, tz)}</span>
          </p>
          {a.contact?.phone && <p className="text-xs text-muted-foreground">{a.contact.phone}</p>}
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

      {/* Reach the customer: chat in the inbox, or (on a phone) call. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={openingChat} onClick={() => void openChat()}>
          {openingChat ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
          {t('message')}
        </Button>
        {callNumber && (
          <a
            href={`tel:${callNumber}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium text-foreground hover:bg-muted md:hidden"
          >
            <Phone className="size-4" />
            {t('call')}
          </a>
        )}
      </div>

      {(a.treatment || a.medicine || a.notes) && mode !== 'complete' && mode !== 'notes' && (
        <div className="mt-2 space-y-0.5 break-words text-xs text-muted-foreground">
          {a.treatment && <p>{t('treatment')}: <span className="text-foreground">{a.treatment}</span></p>}
          {a.medicine && <p>{t('medicine')}: <span className="text-foreground">{a.medicine}</span></p>}
          {a.notes && <p>{t('notes')}: <span className="text-foreground">{a.notes}</span></p>}
        </div>
      )}
      {(a.attachments?.length ?? 0) > 0 && mode !== 'complete' && mode !== 'notes' && (
        <FileList files={a.attachments ?? []} />
      )}
      {(a.details?.requirements || a.details?.address || (a.details?.answers?.length ?? 0) > 0) && (
        <div className="mt-2 space-y-0.5 break-words rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{t('customerSaid')}</p>
          {a.details?.requirements && (
            <p>{t('detailRequirements')}: <span className="text-foreground">{a.details.requirements}</span></p>
          )}
          {a.details?.address && (
            <p>{t('detailAddress')}: <span className="text-foreground">{a.details.address}</span></p>
          )}
          {(a.details?.answers ?? []).map((x, i) => (
            <p key={i}>{x.q}: <span className="text-foreground">{x.a}</span></p>
          ))}
        </div>
      )}
      {a.status === 'pending' && mode === null && !readOnly && (
        <div className="mt-2 rounded-lg border border-violet-500/40 bg-violet-500/5 p-2.5">
          <p className="text-xs text-violet-200">{t('pendingNote')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void act({ action: 'confirm' }, t('confirmedDone'))}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              {t('confirmBooking')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('confirmMove')}>
              {t('confirmOtherTime')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (confirm(t('declineConfirm'))) void act({ action: 'decline' }, t('declinedDone'));
              }}
            >
              {t('decline')}
            </Button>
          </div>
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

      {mode === null && !readOnly && (
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t('noShowConfirm'))) void act({ action: 'no_show' }, t('noShowDone'));
                  }}
                >
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

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <p className="text-xs font-medium text-foreground">
              {t('documents')} ({files.length}/{MAX_FILES})
            </p>
            <p className="text-[11px] text-muted-foreground">{t('documentsHint', { max: MAX_FILES })}</p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={FILE_TYPES.join(',')}
              className="hidden"
              onChange={(e) => void addFiles(e.target.files)}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => void addFiles(e.target.files)}
            />
            <FileList files={files} onRemove={(url) => setFiles((prev) => prev.filter((f) => f.url !== url))} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={uploading || files.length >= MAX_FILES} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                {t('upload')}
              </Button>
              <Button size="sm" variant="outline" disabled={uploading || files.length >= MAX_FILES} onClick={() => cameraRef.current?.click()}>
                <Camera className="size-4" />
                {t('camera')}
              </Button>
            </div>
          </div>

          {mode === 'complete' && (
            <div className="space-y-2 rounded-lg border border-border p-2.5">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                  checked={nextOn}
                  onChange={(e) => {
                    setNextOn(e.target.checked);
                    if (!e.target.checked) {
                      setNextDate('');
                      setNextTime(null);
                    }
                  }}
                />
                <span>
                  {t('nextVisit')}
                  <span className="block text-xs text-muted-foreground">{t('nextVisitHint')}</span>
                </span>
              </label>
              {nextOn && (
                <>
                  <DayPicker
                    channelId={channelId}
                    ignoreId={a.id}
                    value={nextDate}
                    onChange={(d) => {
                      setNextDate(d);
                      setNextTime(null);
                    }}
                  />
                  <SlotPicker channelId={channelId} date={nextDate} ignoreId={a.id} value={nextTime} onChange={setNextTime} />
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || uploading || (mode === 'complete' && nextOn && (!nextDate || !nextTime))}
              onClick={() =>
                void act(
                  {
                    action: mode === 'complete' ? 'complete' : 'notes',
                    treatment,
                    medicine,
                    notes,
                    attachments: files,
                    ...(mode === 'complete' && nextOn && nextDate && nextTime ? { next_date: nextDate, next_time: nextTime } : {}),
                  },
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

      {mode === 'confirmMove' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t('confirmOtherTimeHint')}</p>
          <DayPicker
            channelId={channelId}
            ignoreId={a.id}
            value={moveDate}
            onChange={(d) => {
              setMoveDate(d);
              setMoveTime(null);
            }}
          />
          <SlotPicker channelId={channelId} date={moveDate} ignoreId={a.id} value={moveTime} onChange={setMoveTime} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !moveDate || !moveTime}
              onClick={() => void act({ action: 'confirm', date: moveDate, time: moveTime }, t('confirmedDone'))}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('confirmBooking')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(null)}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'move' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t('newDate')}</p>
          <DayPicker
            channelId={channelId}
            ignoreId={a.id}
            value={moveDate}
            onChange={(d) => {
              setMoveDate(d);
              setMoveTime(null);
            }}
          />
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

function FileList({ files, onRemove }: { files: Attachment[]; onRemove?: (url: string) => void }) {
  const t = useTranslations('Appointments');
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.url} className="relative">
          <a
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={f.name}
            className="flex size-16 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"
          >
            {f.mime === 'application/pdf' ? (
              <span className="flex flex-col items-center gap-0.5 text-[10px] text-muted-foreground">
                <FileText className="size-5" />
                PDF
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={f.url} alt={f.name} loading="lazy" className="size-full object-cover" />
            )}
          </a>
          {onRemove && (
            <button
              type="button"
              aria-label={t('removeFile')}
              onClick={() => onRemove(f.url)}
              className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-black/70 text-white"
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
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
  void tz;
  const [who, setWho] = useState<'existing' | 'new'>('existing');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [contact, setContact] = useState<ContactHit | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState<string | null>(null);
  const newPhoneOk = newPhone.replace(/\D/g, '').length >= 10;
  const customerReady = who === 'existing' ? !!contact : newPhoneOk;
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
          .eq('is_group', false)
          .not('phone', 'is', null)
          .neq('phone', '');
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
    if (!customerReady || !date || !time) return;
    setBusy(true);
    try {
      const res = await api<{ appointment: Appointment; message_error: string | null }>('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          who === 'existing'
            ? { channel_id: channelId, contact_id: contact?.id, date, time }
            : { channel_id: channelId, new_contact: { name: newName, phone: newPhone }, date, time },
        ),
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
      <Section title={t('pickContact')} hint={who === 'existing' ? t('pickContactHint') : t('newNumberHint')}>
        <div className="flex gap-1.5">
          {(['existing', 'new'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setWho(k)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                who === k
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(k === 'existing' ? 'fromContacts' : 'newNumber')}
            </button>
          ))}
        </div>
        {who === 'new' ? (
          <>
            <Label text={t('newName')}>
              <Input className="bg-muted" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
            </Label>
            <Label text={t('newPhone')}>
              <Input
                className="bg-muted"
                inputMode="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="98765 43210"
                maxLength={20}
              />
            </Label>
            <p className="text-xs text-muted-foreground">{t('newPhoneHint')}</p>
          </>
        ) : contact ? (
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
        <DayPicker
          channelId={channelId}
          value={date}
          onChange={(d) => {
            setDate(d);
            setTime(null);
          }}
        />
        {date && <p className="text-xs text-muted-foreground">{longDay(date)}</p>}
        <SlotPicker channelId={channelId} date={date} value={time} onChange={setTime} />
        <Button disabled={busy || !customerReady || !date || !time} onClick={() => void book()}>
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

/**
 * Booking in chat needs an AI key to understand what customers write.
 * A business that does not use the AI agent can save a key right here:
 * it is stored as the account's AI key with the AI agent left switched
 * off, so nothing else starts replying.
 */
function AiKeySetup({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void | Promise<void> }) {
  const t = useTranslations('Appointments');
  const [provider, setProvider] = useState<'gemini' | 'openai'>('gemini');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.gemini);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: key.trim(),
          // Only the key is being set up: the AI agent itself stays off.
          is_active: false,
          auto_reply_enabled: false,
        }),
      });
      toast.success(t('aiKeySaved'));
      setKey('');
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 9000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-xs text-amber-300">{t('aiNoKey')}</p>
      {canEdit ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Label text={t('aiProvider')}>
              <select
                className={cn(field, 'w-full')}
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as 'gemini' | 'openai';
                  setProvider(next);
                  setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
                }}
              >
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI</option>
              </select>
            </Label>
            <Label text={t('aiModel')}>
              <Input className="bg-muted font-mono text-sm" value={model} onChange={(e) => setModel(e.target.value)} />
            </Label>
          </div>
          <Label text={t('aiKey')}>
            <Input
              type="password"
              autoComplete="new-password"
              className="bg-muted font-mono text-sm"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider === 'gemini' ? 'AIza...' : 'sk-...'}
            />
          </Label>
          <p className="text-[11px] text-muted-foreground">{t('aiKeyHint')}</p>
          <Button size="sm" disabled={saving || !key.trim() || !model.trim()} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('aiKeySave')}
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
      )}
    </div>
  );
}

function SettingsTab({
  bundle,
  canEdit,
  onSaved,
  onAiChanged,
}: {
  bundle: SettingsBundle;
  canEdit: boolean;
  onSaved: (s: AppointmentSettings) => void;
  onAiChanged: () => void | Promise<void>;
}) {
  const t = useTranslations('Appointments');
  const [s, setS] = useState<AppointmentSettings>(bundle.settings);
  const [saving, setSaving] = useState(false);
  const [holiday, setHoliday] = useState('');
  const [holidayTo, setHolidayTo] = useState('');
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

  // Closed dates are saved the moment one is added or removed; they do
  // not wait for "Save settings".
  const [savingDates, setSavingDates] = useState(false);
  const saveDates = async (next: string[]) => {
    const before = s.holidays;
    set('holidays', next);
    setSavingDates(true);
    try {
      const res = await api<{ settings: AppointmentSettings }>('/api/appointments/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: s.channel_id, holidays: next }),
      });
      setS((prev) => ({ ...prev, id: res.settings.id, holidays: res.settings.holidays }));
      onSaved({ ...bundle.settings, id: res.settings.id, holidays: res.settings.holidays });
      toast.success(t('closedDatesSaved'));
    } catch (err) {
      set('holidays', before);
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setSavingDates(false);
    }
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

  const todayKey = dayKey(new Date(), s.timezone);
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
          {bundle.ai.has_key && !bundle.ai.can_book && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              {t('aiWrongProvider', { provider: bundle.ai.provider ?? '' })}
            </p>
          )}
          {bundle.ai.has_key && bundle.ai.can_book && (
            <p className="text-xs text-muted-foreground">{bundle.ai.agent_on ? t('aiAgentOn') : t('aiAgentOff')}</p>
          )}
        </Section>

        <Section title={t('aiKeyTitle')} hint={t('aiKeyTitleHint')}>
          {bundle.ai.has_key ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Label text={t('aiProvider')}>
                  <Input readOnly className="bg-muted text-sm opacity-80" value={PROVIDER_NAMES[bundle.ai.provider ?? ''] ?? bundle.ai.provider ?? ''} />
                </Label>
                <Label text={t('aiModel')}>
                  <Input readOnly className="bg-muted font-mono text-sm opacity-80" value={bundle.ai.model ?? ''} />
                </Label>
                <Label text={t('aiKey')}>
                  <Input readOnly className="bg-muted font-mono text-sm opacity-80" value="••••••••••••" />
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">{t('aiKeyFromAgent')}</p>
            </>
          ) : (
            <AiKeySetup canEdit={canEdit} onSaved={onAiChanged} />
          )}
          <Link href="/agents" className="inline-flex items-center gap-1.5 text-sm text-primary underline">
            <ExternalLink className="size-4" />
            {bundle.ai.has_key ? t('aiOpenAgent') : t('aiOpenAgentSetup')}
          </Link>
        </Section>

        <Section title={t('business')}>
          <Label text={t('businessName')}>
            <Input className="bg-muted" disabled={off} value={s.business_name ?? ''} onChange={(e) => set('business_name', e.target.value)} placeholder={t('businessNameExample')} />
          </Label>
          <Label text={t('address')}>
            <Textarea rows={2} className="bg-muted" disabled={off} value={s.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Label>
          <Label text={t('language')}>
            <select className={cn(field, 'w-full')} disabled={off} value={s.reply_language ?? 'auto'} onChange={(e) => set('reply_language', e.target.value)}>
              <option value="auto">{t('languageAuto')}</option>
              {Object.entries(REPLY_LANGUAGES).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </Label>
          <p className="-mt-1 text-[11px] text-muted-foreground">{t('languageHint')}</p>
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

        <Section title={t('beforeBooking')} hint={t('beforeBookingHint')}>
          {(
            [
              ['confirm_required', t('confirmRequired'), t('confirmRequiredHint')],
              ['ask_requirements', t('askRequirements'), t('askRequirementsHint')],
              ['ask_address', t('askAddress'), t('askAddressHint')],
              ['send_brand_logo', t('sendBrandLogo'), t('sendBrandLogoHint')],
            ] as ['confirm_required' | 'ask_requirements' | 'ask_address' | 'send_brand_logo', string, string][]
          ).map(([key, label, hint]) => (
            <label key={key} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={!!s[key]}
                disabled={off}
                onChange={(e) => set(key, e.target.checked)}
              />
              <span>
                {label}
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t('customQuestions')}</p>
            {(s.custom_questions ?? []).map((q, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="bg-muted"
                  disabled={off}
                  value={q}
                  maxLength={200}
                  placeholder={t('customQuestionExample')}
                  onChange={(e) => set('custom_questions', s.custom_questions.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button
                  type="button"
                  disabled={off}
                  aria-label={t('removeQuestion')}
                  title={t('removeQuestion')}
                  onClick={() => set('custom_questions', s.custom_questions.filter((_, j) => j !== i))}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border border-red-500/50 text-red-400 hover:bg-red-500/15 disabled:opacity-40"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={off || (s.custom_questions ?? []).length >= 10}
              onClick={() => set('custom_questions', [...(s.custom_questions ?? []), ''])}
            >
              <Plus className="size-4" />
              {t('addQuestion')}
            </Button>
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
          <div className="flex flex-wrap items-end gap-2">
            <Label text={t('holidayFrom')}>
              <input type="date" className={field} disabled={off} value={holiday} onChange={(e) => setHoliday(e.target.value)} />
            </Label>
            <Label text={t('holidayTo')}>
              <input type="date" className={field} disabled={off} min={holiday || undefined} value={holidayTo} onChange={(e) => setHolidayTo(e.target.value)} />
            </Label>
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              disabled={off || savingDates || !holiday || (!!holidayTo && holidayTo < holiday)}
              onClick={() => {
                // One date, or every date from the first to the last.
                const last = holidayTo && holidayTo >= holiday ? holidayTo : holiday;
                const add: string[] = [];
                for (let d = holiday, i = 0; d <= last && i < 366; d = shiftDay(d, 1), i++) add.push(d);
                void saveDates([...new Set([...s.holidays, ...add])].sort());
                setHoliday('');
                setHolidayTo('');
              }}
            >
              {savingDates && <Loader2 className="size-4 animate-spin" />}
              {t('addHoliday')}
            </Button>
          </div>
          {s.holidays.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noClosedDates')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {s.holidays.map((d) => (
                <li
                  key={d}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm',
                    d < todayKey && 'opacity-50',
                  )}
                >
                  <span className="min-w-0 truncate">{longDay(d)}</span>
                  <button
                    type="button"
                    disabled={off || savingDates}
                    aria-label={t('removeHoliday')}
                    title={t('removeHoliday')}
                    onClick={() => void saveDates(s.holidays.filter((x) => x !== d))}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border border-red-500/50 text-red-400 hover:bg-red-500/15 disabled:opacity-40"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
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
