'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Gift, Loader2, Play } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel, type ChannelSummary } from '@/hooks/use-channels';
import { isValidTimeZone, WISH_FREQUENCIES, type WishFrequency } from '@/lib/wishes/schedule';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';

interface RunResult {
  at?: string;
  manual?: boolean;
  due?: number;
  sent?: number;
  failed?: number;
  truncated?: boolean;
  error?: string;
}

interface Schedule {
  channel_id: string;
  saved: boolean;
  enabled: boolean;
  frequency: WishFrequency;
  timezone: string;
  time_of_day: string;
  day_of_week: number | null;
  day_of_month: number | null;
  month: number | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: RunResult | null;
  wish_count: number;
}

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** The time zones offered in the dropdown — India first, the default. */
const TIMEZONES: { id: string; name: string }[] = [
  { id: 'Asia/Kolkata', name: 'India (IST)' },
  { id: 'Asia/Dubai', name: 'Dubai, Abu Dhabi' },
  { id: 'Asia/Riyadh', name: 'Riyadh, Kuwait, Qatar' },
  { id: 'Asia/Karachi', name: 'Pakistan' },
  { id: 'Asia/Kathmandu', name: 'Nepal' },
  { id: 'Asia/Dhaka', name: 'Bangladesh' },
  { id: 'Asia/Colombo', name: 'Sri Lanka' },
  { id: 'Asia/Bangkok', name: 'Bangkok, Jakarta' },
  { id: 'Asia/Singapore', name: 'Singapore, Kuala Lumpur' },
  { id: 'Asia/Hong_Kong', name: 'Hong Kong' },
  { id: 'Asia/Tokyo', name: 'Tokyo, Seoul' },
  { id: 'Australia/Sydney', name: 'Sydney, Melbourne' },
  { id: 'Pacific/Auckland', name: 'Auckland' },
  { id: 'Europe/Moscow', name: 'Moscow' },
  { id: 'Africa/Nairobi', name: 'Nairobi' },
  { id: 'Africa/Johannesburg', name: 'Johannesburg' },
  { id: 'Africa/Lagos', name: 'Lagos' },
  { id: 'Europe/Paris', name: 'Paris, Berlin, Madrid' },
  { id: 'Europe/London', name: 'London, Dublin' },
  { id: 'UTC', name: 'UTC' },
  { id: 'America/Sao_Paulo', name: 'São Paulo' },
  { id: 'America/New_York', name: 'New York, Toronto' },
  { id: 'America/Chicago', name: 'Chicago, Mexico City' },
  { id: 'America/Denver', name: 'Denver' },
  { id: 'America/Los_Angeles', name: 'Los Angeles, Vancouver' },
];

/** "GMT+5:30" for a zone, right now. */
function zoneOffset(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((x) => x.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/** "14:05" → { hour: "2", minute: "05", period: "PM" } */
function splitTime(value: string): { hour: string; minute: string; period: 'AM' | 'PM' } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value) ?? ['', '9', '00'];
  const h = Math.min(23, Number(m[1]));
  return {
    hour: String(h % 12 === 0 ? 12 : h % 12),
    minute: m[2],
    period: h >= 12 ? 'PM' : 'AM',
  };
}

function joinTime(hour: string, minute: string, period: string): string {
  const h = (Number(hour) % 12) + (period === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${minute}`;
}

/**
 * Settings → Wish Scheduler. One card per WhatsApp number: when that
 * number's wishes are checked, and a "Run now" for an immediate check.
 * The wishes themselves live on each contact (Wish tab).
 */
export function WishScheduler() {
  const t = useTranslations('Settings.wishes');
  const { channels } = useChannels();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/wishes/schedules', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { schedules?: Schedule[] };
      if (!res.ok) throw new Error();
      setSchedules(body.schedules ?? []);
    } catch {
      setSchedules([]);
      toast.error(t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const replace = (next: Schedule) =>
    setSchedules((prev) => prev?.map((s) => (s.channel_id === next.channel_id ? next : s)) ?? prev);

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {schedules === null || channels === null ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">{t('noNumbers')}</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {schedules.map((s) => (
            <ScheduleCard
              key={s.channel_id}
              schedule={s}
              channel={channels.find((c) => c.id === s.channel_id) ?? null}
              onChange={replace}
            />
          ))}
          <p className="text-xs text-muted-foreground">{t('precisionNote')}</p>
        </div>
      )}
    </section>
  );
}

function ScheduleCard({
  schedule,
  channel,
  onChange,
}: {
  schedule: Schedule;
  channel: ChannelSummary | null;
  onChange: (next: Schedule) => void;
}) {
  const t = useTranslations('Settings.wishes');
  const locale = useLocale();
  const { canEditSettings } = useAuth();

  const [enabled, setEnabled] = useState(schedule.enabled);
  const [frequency, setFrequency] = useState<WishFrequency>(schedule.frequency);
  const [timezone, setTimezone] = useState(
    isValidTimeZone(schedule.timezone) ? schedule.timezone : DEFAULT_TIMEZONE,
  );
  const [time, setTime] = useState(schedule.time_of_day);
  const [dayOfWeek, setDayOfWeek] = useState(schedule.day_of_week ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(schedule.day_of_month ?? 1);
  const [month, setMonth] = useState(schedule.month ?? 1);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const id = `wish-${schedule.channel_id}`;
  const clock = splitTime(time);
  // The listed zones, plus the saved one if it is not among them.
  const zoneItems = useMemo(() => {
    const zones = TIMEZONES.some((z) => z.id === timezone)
      ? TIMEZONES
      : [...TIMEZONES, { id: timezone, name: timezone }];
    return zones.map((z) => {
      const offset = zoneOffset(z.id);
      return { id: z.id, label: offset && z.id !== 'UTC' ? `${z.name} · ${offset}` : z.name };
    });
  }, [timezone]);
  const minuteItems = MINUTES.includes(clock.minute) ? MINUTES : [...MINUTES, clock.minute].sort();
  const shownTz = isValidTimeZone(schedule.timezone) ? schedule.timezone : 'UTC';

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    // 4 Jan 1970 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(1970, 0, 4 + i))));
  }, [locale]);
  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2024, i, 1))));
  }, [locale]);

  const dirty =
    !schedule.saved ||
    enabled !== schedule.enabled ||
    frequency !== schedule.frequency ||
    timezone !== schedule.timezone ||
    time !== schedule.time_of_day ||
    (frequency === 'weekly' && dayOfWeek !== schedule.day_of_week) ||
    ((frequency === 'monthly' || frequency === 'yearly') && dayOfMonth !== schedule.day_of_month) ||
    (frequency === 'yearly' && month !== schedule.month);

  const formatWhen = (iso: string | null, fallback: string) =>
    iso
      ? new Date(iso).toLocaleString(locale, {
          timeZone: shownTz,
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : fallback;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/wishes/schedules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_id: schedule.channel_id,
          enabled,
          frequency,
          timezone,
          time_of_day: time || '09:00',
          day_of_week: dayOfWeek,
          day_of_month: dayOfMonth,
          month,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        schedule?: Partial<Schedule>;
        error?: string;
      };
      if (!res.ok || !body.schedule) {
        toast.error(t('saveFailed', { reason: body.error || `HTTP ${res.status}` }));
        return;
      }
      onChange({ ...schedule, ...body.schedule, saved: true } as Schedule);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed', { reason: t('networkError') }));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch(`/api/wishes/schedules/${schedule.channel_id}/run`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        result?: RunResult;
        schedule?: Partial<Schedule>;
        error?: string;
      };
      if (!res.ok || !body.result) {
        toast.error(t('runFailed', { reason: body.error || `HTTP ${res.status}` }));
        return;
      }
      if (body.schedule) onChange({ ...schedule, ...body.schedule, saved: true } as Schedule);
      const r = body.result;
      if (r.error) toast.error(t('runFailed', { reason: r.error }));
      else if (!r.due) toast.success(t('runNothing'));
      else toast.success(t('runDone', { sent: r.sent ?? 0, failed: r.failed ?? 0 }));
    } catch {
      toast.error(t('runFailed', { reason: t('networkError') }));
    } finally {
      setRunning(false);
    }
  }

  const disabled = !canEditSettings || saving || running;
  const last = schedule.last_result;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Gift className="size-4 shrink-0 text-primary" />
              <span className="truncate">{channel ? channelLabel(channel) : t('unknownNumber')}</span>
            </CardTitle>
            <CardDescription className="mt-1 text-muted-foreground">
              {channel?.provider === 'waha' ? t('kindWeb') : t('kindApi')}
              {' · '}
              {t('wishCount', { count: schedule.wish_count })}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor={`${id}-on`} className="text-xs text-muted-foreground">
              {t('enabled')}
            </Label>
            <Switch
              id={`${id}-on`}
              checked={enabled}
              onCheckedChange={(v) => setEnabled(!!v)}
              disabled={disabled}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('frequency')}</Label>
            <Select
              value={frequency}
              onValueChange={(v) => v && setFrequency(v as WishFrequency)}
              disabled={disabled}
              items={Object.fromEntries(WISH_FREQUENCIES.map((f) => [f, t(`freq.${f}`)]))}
            >
              <SelectTrigger className="w-full" aria-label={t('frequency')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WISH_FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(`freq.${f}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('timezone')}</Label>
            <Select
              value={timezone}
              onValueChange={(v) => v && setTimezone(String(v))}
              disabled={disabled}
              items={Object.fromEntries(zoneItems.map((z) => [z.id, z.label]))}
            >
              <SelectTrigger className="w-full" aria-label={t('timezone')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zoneItems.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {frequency === 'weekly' && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t('dayOfWeek')}</Label>
              <Select
                value={String(dayOfWeek)}
                onValueChange={(v) => v && setDayOfWeek(Number(v))}
                disabled={disabled}
                items={Object.fromEntries(weekdays.map((name, i) => [String(i), name]))}
              >
                <SelectTrigger className="w-full" aria-label={t('dayOfWeek')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {weekdays.map((name, i) => (
                    <SelectItem key={name} value={String(i)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {frequency === 'yearly' && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t('month')}</Label>
              <Select
                value={String(month)}
                onValueChange={(v) => v && setMonth(Number(v))}
                disabled={disabled}
                items={Object.fromEntries(months.map((name, i) => [String(i + 1), name]))}
              >
                <SelectTrigger className="w-full" aria-label={t('month')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((name, i) => (
                    <SelectItem key={name} value={String(i + 1)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {(frequency === 'monthly' || frequency === 'yearly') && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t('dayOfMonth')}</Label>
              <Select
                value={String(dayOfMonth)}
                onValueChange={(v) => v && setDayOfMonth(Number(v))}
                disabled={disabled}
              >
                <SelectTrigger className="w-full" aria-label={t('dayOfMonth')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>
                      {i + 1}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {frequency !== 'hourly' && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t('time')}</Label>
              <div className="grid grid-cols-3 gap-2">
                <Select
                  value={clock.hour}
                  onValueChange={(v) => v && setTime(joinTime(String(v), clock.minute, clock.period))}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full" aria-label={t('hour')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={clock.minute}
                  onValueChange={(v) => v && setTime(joinTime(clock.hour, String(v), clock.period))}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full" aria-label={t('minute')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {minuteItems.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={clock.period}
                  onValueChange={(v) => v && setTime(joinTime(clock.hour, clock.minute, String(v)))}
                  disabled={disabled}
                  items={{ AM: t('am'), PM: t('pm') }}
                >
                  <SelectTrigger className="w-full" aria-label={t('amPm')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AM">{t('am')}</SelectItem>
                    <SelectItem value="PM">{t('pm')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex gap-1.5">
            <dt>{t('lastRun')}:</dt>
            <dd className="text-foreground">{formatWhen(schedule.last_run_at, t('never'))}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>{t('nextRun')}:</dt>
            <dd className="text-foreground">
              {schedule.enabled ? formatWhen(schedule.next_run_at, t('notScheduled')) : t('notScheduled')}
            </dd>
          </div>
          {last ? (
            <div className="sm:col-span-2">
              {last.error ? (
                <span className="text-red-400">{t('lastResultError', { reason: last.error })}</span>
              ) : (
                <span>
                  {t('lastResult', { sent: last.sent ?? 0, failed: last.failed ?? 0 })}
                  {last.truncated ? ` ${t('truncated')}` : ''}
                </span>
              )}
            </div>
          ) : null}
        </dl>

        {canEditSettings ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={disabled || !dirty}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
            <Button variant="outline" onClick={runNow} disabled={disabled}>
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('running')}
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  {t('runNow')}
                </>
              )}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}
