// ============================================================
// Blocked accounts, as the server's background work sees them.
//
// Blocking an account (migration 085) is a full stop: its people
// cannot sign in, and nothing happens on its behalf either — messages
// arriving for it are not taken in, nothing is sent from its numbers
// (AI replies, automations, flows, reminders, wishes, broadcasts), and
// the scheduled jobs pass over it. Reactivating lets all of it run
// again from that moment.
//
// The list of blocked accounts is small and read by every incoming
// message and every send, so it is kept for a few seconds. A failed
// read answers with the last list known (or none): a database hiccup
// must not stop every customer's messages.
//
// Server-only.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'

const KEEP_MS = 15_000

let kept: { at: number; ids: Set<string> } | null = null

/** Thrown when something is about to be sent for a blocked account. */
export class AccountBlockedSendError extends Error {
  readonly code = 'account_blocked' as const
  constructor() {
    super('This account is blocked; nothing is sent from it.')
    this.name = 'AccountBlockedSendError'
  }
}

/** Ids of every blocked account. */
export async function blockedAccountIds(): Promise<Set<string>> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.ids
  try {
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('id')
      .not('blocked_at', 'is', null)
      .limit(10000)
    if (error) throw new Error(error.message)
    kept = { at: Date.now(), ids: new Set(((data ?? []) as { id: string }[]).map((r) => r.id)) }
  } catch (err) {
    console.error('[blocked] list not read:', err instanceof Error ? err.message : err)
    if (!kept) return new Set()
  }
  return kept.ids
}

export async function accountIsBlocked(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return false
  return (await blockedAccountIds()).has(accountId)
}

/** Call right after blocking or reactivating, so this server sees it at once. */
export function forgetBlockedAccounts(): void {
  kept = null
}

/**
 * Leaves blocked accounts out of a scheduled job's query (the rows
 * must carry `account_id`). Their rows stay as they are, so they are
 * neither sent nor marked failed.
 */
export function withoutBlocked<Q>(query: Q, blocked: Set<string>): Q {
  if (blocked.size === 0) return query
  // Every Supabase filter builder has `not`; spelling that out as a
  // type constraint sends the compiler into the builder's generics.
  const filter = query as unknown as { not(column: string, operator: string, value: string): Q }
  return filter.not('account_id', 'in', `(${[...blocked].join(',')})`)
}
