'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { createClient } from '@/lib/supabase/client'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

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

/**
 * Appointments per week on the dashboard. Shown only when booking in
 * chat is switched on for at least one WhatsApp number (migration 073);
 * otherwise it renders nothing. `channelId` narrows it to the number
 * the dashboard is filtered to.
 */
export function AppointmentsTrendCard({ channelId }: { channelId?: string | null }) {
  const t = useTranslations('Appointments')
  const [state, setState] = useState<{ tz: string; rows: Row[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    ;(async () => {
      let settingsQuery = supabase.from('appointment_settings').select('channel_id, timezone').eq('enabled', true)
      if (channelId) settingsQuery = settingsQuery.eq('channel_id', channelId)
      const { data: settings } = await settingsQuery
      const enabled = (settings ?? []) as { channel_id: string; timezone: string }[]
      if (cancelled) return
      if (enabled.length === 0) {
        setState(null)
        return
      }
      const since = new Date(Date.now() - 70 * 86_400_000).toISOString()
      const { data } = await supabase
        .from('appointments')
        .select('starts_at, status')
        .in('channel_id', enabled.map((s) => s.channel_id))
        .gte('starts_at', since)
        .order('starts_at', { ascending: true })
        .limit(5000)
      if (cancelled) return
      setState({ tz: enabled[0].timezone || 'Asia/Kolkata', rows: (data as Row[] | null) ?? [] })
    })()
    return () => {
      cancelled = true
    }
  }, [channelId])

  const view = useMemo(() => {
    if (!state) return null
    const now = new Date()
    const today = dayKey(now, state.tz)
    const [y, m, d] = today.split('-').map(Number)
    const monday = shiftDay(today, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7))
    const keyed = state.rows
      .filter((r) => r.status !== 'cancelled')
      .map((r) => ({ day: dayKey(r.starts_at, state.tz), at: Date.parse(r.starts_at), status: r.status }))
    const weeks = []
    for (let i = 7; i >= -1; i--) {
      const from = shiftDay(monday, -7 * i)
      const to = shiftDay(from, 6)
      weeks.push({
        from,
        label: from.slice(5).replace('-', '/'),
        count: keyed.filter((r) => r.day >= from && r.day <= to).length,
        current: today >= from && today <= to,
      })
    }
    const max = Math.max(1, ...weeks.map((w) => w.count))
    return {
      weeks: weeks.map((w) => ({ ...w, pct: Math.round((w.count / max) * 100) })),
      today: keyed.filter((r) => r.day === today).length,
      upcoming: keyed.filter((r) => r.status === 'booked' && r.at > now.getTime()).length,
    }
  }, [state])

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
        <div className="mt-4 flex h-32 items-end gap-1.5">
          {view.weeks.map((w) => (
            <div key={w.from} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] text-muted-foreground">{w.count}</span>
              <div
                className={cn('w-full rounded-t', w.current ? 'bg-primary' : 'bg-primary/40')}
                style={{ height: `${Math.max(w.count ? 6 : 1, w.pct * 0.7)}%` }}
              />
              <span className="w-full truncate text-center text-[10px] text-muted-foreground">{w.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
