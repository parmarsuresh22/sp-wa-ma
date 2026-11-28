// ============================================================
// A WhatsApp number that is not connected is paused.
//
// While a number is disconnected (its WhatsApp Web session is logged
// out or stopped, or its API connection is broken) nothing scheduled
// runs for it: no reminders, no wishes. The portal also hides it from
// the modules (see `useChannels`). Nothing is deleted: the moment the
// number is connected again, everything of that number is back.
//
// Read by scheduled jobs, so the list is remembered for a few seconds.
// Anything that goes wrong reading it pauses nothing.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'

const KEEP_MS = 15_000
let remembered: { at: number; ids: Set<string> } | null = null

/** Ids of the numbers that are not connected right now. */
export async function inactiveChannelIds(): Promise<Set<string>> {
  if (remembered && Date.now() - remembered.at < KEEP_MS) return remembered.ids
  let ids = new Set<string>()
  try {
    const { data, error } = await supabaseAdmin().from('whatsapp_config').select('id').neq('status', 'connected')
    if (error) throw new Error(error.message)
    ids = new Set(((data ?? []) as { id: string }[]).map((r) => r.id))
  } catch (err) {
    console.error('[channels] could not read the paused numbers:', err instanceof Error ? err.message : err)
  }
  remembered = { at: Date.now(), ids }
  return ids
}

/** Leave out the rows of numbers that are not connected. */
export function withoutInactiveChannels<Q>(query: Q, inactive: Set<string>, column = 'channel_id'): Q {
  if (inactive.size === 0) return query
  const filter = query as unknown as { not(column: string, operator: string, value: string): Q }
  return filter.not(column, 'in', `(${[...inactive].join(',')})`)
}
