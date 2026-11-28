'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { TrendBars, dailyBuckets } from '@/components/appointments/trend-bars'

interface Row {
  starts_at: string
  status: string
}

/** YYYY-MM-DD of an instant on the business's own calendar. */
function dayKey(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    typeof at === 'string' ? new Date(at) : at,
  )
}

function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

interface Loaded {
  tz: string
  /** The number a "open" link should land on. */
  channelId: string
  rows: Row[]
}

// Both dashboard cards ask for the same rows; one request serves both.
const inflight = new Map<string, { at: number; promise: Promise<Loaded | null> }>()

function loadEnabledAppointments(channelId: string | null): Promise<Loaded | null> {
  const key = channelId ?? 'all'
  const hit = inflight.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.promise
  const promise = (async (): Promise<Loaded | null> => {
    const supabase = createClient()
    let settingsQuery = supabase.from('appointment_settings').select('channel_id, timezone').eq('enabled', true)
    if (channelId) settingsQuery = settingsQuery.eq('channel_id', channelId)
    const { data: settings } = await settingsQuery
    const enabled = (settings ?? []) as { channel_id: string; timezone: string }[]
    if (enabled.length === 0) return null
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const { data } = await supabase
      .from('appointments')
      .select('starts_at, status')
      .in('channel_id', enabled.map((s) => s.channel_id))
      .gte('starts_at', since)
      .order('starts_at', { ascending: true })
      .limit(10000)
    return { tz: enabled[0].timezone || 'Asia/Kolkata', channelId: enabled[0].channel_id, rows: (data as Row[] | null) ?? [] }
  })()
  inflight.set(key, { at: Date.now(), promise })
  return promise
}

/** Appointments of the numbers with booking in chat on; null when none. */
function useEnabledAppointments(channelId?: string | null): Loaded | null {
  const [state, setState] = useState<{ key: string; data: Loaded | null } | null>(null)
  const key = channelId ?? 'all'
  useEffect(() => {
    let cancelled = false
    const k = channelId ?? 'all'
    loadEnabledAppointments(channelId ?? null)
      .then((data) => {
        if (!cancelled) setState({ key: k, data })
      })
      .catch(() => {
        if (!cancelled) setState({ key: k, data: null })
      })
    return () => {
      cancelled = true
    }
  }, [channelId])
  return state && state.key === key ? state.data : null
}

/**
 * This month's appointments as a calendar, at the top of the dashboard.
 * Shown only when booking in chat is on for at least one WhatsApp
 * number. A day opens the Appointments page on that day.
 */
export function AppointmentsCalendarCard({ channelId }: { channelId?: string | null }) {
  const t = useTranslations('Appointments')
  const state = useEnabledAppointments(channelId)
  const [monthPick, setMonthPick] = useState<string | null>(null)

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of state?.rows ?? []) {
      if (r.status === 'cancelled') continue
      const d = dayKey(r.starts_at, state!.tz)
      m.set(d, (m.get(d) ?? 0) + 1)
    }
    return m
  }, [state])

  if (!state) return null
  const today = dayKey(new Date(), state.tz)
  const month = monthPick ?? today.slice(0, 7)
  const [y, mo] = month.split('-').map(Number)
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`)
  const title = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, mo - 1, 1)),
  )
  const move = (delta: number) => setMonthPick(new Date(Date.UTC(y, mo - 1 + delta, 1)).toISOString().slice(0, 7))
  const link = (day?: string) =>
    `/appointments?channel=${channelId ?? state.channelId}${day ? `&day=${day}` : ''}`

  return (
    <Card className="lg:w-1/2">
      <CardHeader>
        <CardTitle>{t('dashCalendarTitle')}</CardTitle>
        <CardDescription>{t('dashCalendarHint', { count: counts.get(today) ?? 0 })}</CardDescription>
        <CardAction>
          <Link href={link()} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            {t('dashOpen')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mx-auto w-full max-w-sm">
          <div className="flex items-center justify-between">
            <button type="button" aria-label={t('prevMonth')} onClick={() => move(-1)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-medium text-foreground">{title}</span>
            <button type="button" aria-label={t('nextMonth')} onClick={() => move(1)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>
                {new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(Date.UTC(2024, 0, 1 + i)))}
              </span>
            ))}
            {cells.map((c, i) =>
              c ? (
                <Link
                  key={c}
                  href={link(c)}
                  className={cn(
                    'flex h-10 flex-col items-center justify-center rounded-md border text-xs leading-none text-foreground hover:border-primary',
                    c === today ? 'border-primary bg-primary/15 font-semibold' : 'border-transparent',
                  )}
                >
                  {Number(c.slice(8))}
                  {(counts.get(c) ?? 0) > 0 && (
                    <span className="mt-0.5 rounded-full bg-primary/30 px-1 text-[10px] leading-[14px]">{counts.get(c)}</span>
                  )}
                </Link>
              ) : (
                <span key={`e${i}`} />
              ),
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Appointments per week on the dashboard. Shown only when booking in
 * chat is switched on for at least one WhatsApp number (migration 073);
 * otherwise it renders nothing. `channelId` narrows it to the number
 * the dashboard is filtered to.
 */
export function AppointmentsTrendCard({ channelId }: { channelId?: string | null }) {
  const t = useTranslations('Appointments')
  const state = useEnabledAppointments(channelId)

  const [by, setBy] = useState<'day' | 'week'>('week')
  const view = useMemo(() => {
    if (!state) return null
    const now = new Date()
    const today = dayKey(now, state.tz)
    const [y, m, d] = today.split('-').map(Number)
    const monday = shiftDay(today, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7))
    const points = state.rows.map((r) => ({ day: dayKey(r.starts_at, state.tz), at: Date.parse(r.starts_at), status: r.status }))
    const weekly = []
    for (let i = 7; i >= -1; i--) {
      const from = shiftDay(monday, -7 * i)
      weekly.push({ key: from, from, to: shiftDay(from, 6), label: from.slice(5).replace('-', '/') })
    }
    const buckets = by === 'day' ? dailyBuckets(today) : weekly
    const live = points.filter((r) => r.status !== 'cancelled')
    return {
      points,
      buckets,
      todayKey: today,
      nowMs: now.getTime(),
      today: live.filter((r) => r.day === today).length,
      upcoming: live.filter((r) => (r.status === 'booked' || r.status === 'pending') && r.at > now.getTime()).length,
    }
  }, [state, by])

  if (!view) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashTitle')}</CardTitle>
        <CardDescription>{t('dashHint')}</CardDescription>
        <CardAction>
          <Link href="/appointments" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            {t('dashOpen')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <p className="text-2xl font-semibold text-foreground">{view.today}</p>
            <p className="text-xs text-muted-foreground">{t('dashToday')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-foreground">{view.upcoming}</p>
            <p className="text-xs text-muted-foreground">{t('dashUpcoming')}</p>
          </div>
        </div>
        <div className="mt-4 flex gap-1.5">
          {(['day', 'week'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setBy(k)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                by === k
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`trendBy.${k}`)}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <TrendBars points={view.points} buckets={view.buckets} today={view.todayKey} nowMs={view.nowMs} />
        </div>
      </CardContent>
    </Card>
  )
}
