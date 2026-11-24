'use client';

import type { TypeStats } from '@/lib/events/service';
import type { EventRow, PassTypeRow } from '@/lib/events/types';

export type EventView = EventRow & { pass_types: PassTypeRow[] };
export type { TypeStats };

export const field =
  'h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50';

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export function postJson(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 text-xs text-muted-foreground">
      <span className="mb-1 block">{text}</span>
      {children}
    </label>
  );
}

/** "Sat, 28 Nov 2026, 7:00 pm" on the event's own calendar. */
export function when(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** A short date and time in the viewer's own timezone (when something happened). */
export function stamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export interface EventTotals {
  capacity: number;
  held: number;
  issued: number;
  used: number;
  review: number;
  awaiting: number;
  revenue: number;
}

export function totalsFor(event: EventView, stats: TypeStats[]): EventTotals {
  const out: EventTotals = { capacity: 0, held: 0, issued: 0, used: 0, review: 0, awaiting: 0, revenue: 0 };
  for (const type of event.pass_types) {
    if (type.active) out.capacity += type.capacity;
    const s = stats.find((row) => row.pass_type_id === type.id);
    if (!s) continue;
    out.held += s.held;
    out.issued += s.issued;
    out.used += s.used;
    out.review += s.review;
    out.awaiting += s.awaiting;
    out.revenue += s.revenue;
  }
  return out;
}
