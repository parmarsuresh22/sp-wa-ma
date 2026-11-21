'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

/** One appointment, reduced to what the trend needs. */
export interface TrendPoint {
  /** YYYY-MM-DD on the business's own calendar. */
  day: string;
  /** Start, in ms. */
  at: number;
  status: string;
}

export interface TrendBucket {
  key: string;
  label: string;
  from: string;
  to: string;
  /** A second, smaller line under the label (the weekday of a day). */
  sub?: string;
}

/** `key` moved by whole days (calendar arithmetic). */
function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * One bar per day: the last ten days, today, and the next three — so
 * yesterday's visits and tomorrow's bookings are both in view.
 */
export function dailyBuckets(today: string): TrendBucket[] {
  const out: TrendBucket[] = [];
  for (let i = -10; i <= 3; i++) {
    const day = shiftDay(today, i);
    const [y, m, d] = day.split('-').map(Number);
    const weekday = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'narrow' }).format(
      new Date(Date.UTC(y, m - 1, d)),
    );
    out.push({ key: day, from: day, to: day, label: String(d), sub: weekday });
  }
  return out;
}

type Kind = 'live' | 'past' | 'cancelled' | 'noShow';

const KINDS: { kind: Kind; color: string }[] = [
  { kind: 'live', color: 'bg-sky-500' },
  { kind: 'past', color: 'bg-emerald-500' },
  { kind: 'noShow', color: 'bg-amber-500' },
  { kind: 'cancelled', color: 'bg-red-500' },
];

/**
 * Which part of the bar an appointment belongs to:
 *   live       booked and still to come
 *   past       took place (completed, or booked and its time has gone)
 *   noShow     the customer did not come
 *   cancelled  cancelled
 */
export function trendKind(point: Pick<TrendPoint, 'at' | 'status'>, nowMs: number): Kind {
  if (point.status === 'cancelled') return 'cancelled';
  if (point.status === 'no_show') return 'noShow';
  if ((point.status === 'booked' || point.status === 'pending') && point.at > nowMs) return 'live';
  return 'past';
}

/**
 * Appointments per period as stacked bars — every appointment counts,
 * cancelled ones included, each in its own colour.
 */
export function TrendBars({
  points,
  buckets,
  today,
  nowMs,
}: {
  points: TrendPoint[];
  buckets: TrendBucket[];
  today: string;
  nowMs: number;
}) {
  const t = useTranslations('Appointments');
  const bars = buckets.map((b) => {
    const counts: Record<Kind, number> = { live: 0, past: 0, cancelled: 0, noShow: 0 };
    for (const p of points) if (p.day >= b.from && p.day <= b.to) counts[trendKind(p, nowMs)]++;
    const total = counts.live + counts.past + counts.cancelled + counts.noShow;
    return { ...b, counts, total, current: today >= b.from && today <= b.to };
  });
  const max = Math.max(1, ...bars.map((b) => b.total));
  const totals: Record<Kind, number> = { live: 0, past: 0, cancelled: 0, noShow: 0 };
  for (const b of bars) for (const { kind } of KINDS) totals[kind] += b.counts[kind];

  return (
    <div>
      <div className="flex h-36 items-end gap-1.5">
        {bars.map((b) => (
          <div key={b.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className={cn('text-[10px]', b.current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {b.total}
            </span>
            <div
              className={cn(
                'flex w-full flex-col-reverse overflow-hidden rounded-t',
                b.total === 0 && 'bg-muted',
                b.current && 'ring-1 ring-primary',
              )}
              style={{ height: `${Math.max(b.total ? 6 : 1, (b.total / max) * 70)}%` }}
              title={KINDS.map(({ kind }) => `${t(`trendKind.${kind}`)}: ${b.counts[kind]}`).join(' · ')}
            >
              {KINDS.map(({ kind, color }) =>
                b.counts[kind] > 0 ? (
                  <div key={kind} className={color} style={{ height: `${(b.counts[kind] / b.total) * 100}%` }} />
                ) : null,
              )}
            </div>
            <span className="w-full truncate text-center text-[10px] leading-tight text-muted-foreground">
              {b.label}
              {b.sub && <span className="block text-[9px] opacity-70">{b.sub}</span>}
            </span>
          </div>
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {KINDS.map(({ kind, color }) => (
          <li key={kind} className="flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-sm', color)} />
            {t(`trendKind.${kind}`)} ({totals[kind]})
          </li>
        ))}
      </ul>
    </div>
  );
}
