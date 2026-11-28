// ============================================================
// Keeping WhatsApp Web sessions connected (migration 088).
//
// A session can drop without anyone asking for it: the bridge
// restarts, the session fails, a start never finishes. This looks at
// every WhatsApp Web number that is not connected and brings its
// session back. The login lives on the bridge, so a start or restart
// reconnects without a new QR code; only when WhatsApp itself logged
// the phone out does the person have to scan again.
//
// A number the person stopped on purpose (`bridge_keep_stopped`) and
// the numbers of a blocked account are left alone.
//
// Called from the scheduled job and whenever somebody's browser loads
// the list of numbers, so it works with or without a scheduler.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { blockedAccountIds } from '@/lib/auth/blocked-server'
import { sessionPatch } from '@/lib/whatsapp/bridge-channel'
import type { ChannelRow } from '@/lib/whatsapp/channels'
import { decrypt } from '@/lib/whatsapp/encryption'
import { createWahaClient, WahaError } from '@/lib/whatsapp/providers/waha'

/** A session that is not connected is looked at this often, at most. */
export const RECOVERY_EVERY_MS = 3 * 60_000
/** A start that has not finished after this long is started over. */
export const STARTING_STALE_MS = 3 * 60_000

export type RecoveryStep =
  /** Nothing to do yet. */
  | 'wait'
  /** Only record what the bridge says (working, or waiting for a QR scan). */
  | 'sync'
  | 'start'
  | 'restart'

/**
 * What to do with a session, from what the bridge reports and how long
 * the row has been in its present state.
 */
export function recoveryStep(bridgeStatus: string | null | undefined, sinceMs: number): RecoveryStep {
  const status = (bridgeStatus ?? '').toUpperCase()
  if (status === 'STOPPED') return 'start'
  if (status === 'FAILED') return 'restart'
  if (status === 'STARTING') return sinceMs > STARTING_STALE_MS ? 'restart' : 'wait'
  // WORKING: the portal missed the news. SCAN_QR_CODE: only the person
  // can finish that. Either way, write down what the bridge says.
  return 'sync'
}

export interface RecoveryResult {
  checked: number
  /** Sessions that turned out to be working already. */
  reconnected: number
  /** Sessions started or restarted. */
  restarted: number
  /** Sessions that need the person to scan a QR code again. */
  needScan: number
  failed: number
}

type Row = ChannelRow & { updated_at?: string | null; bridge_keep_stopped?: boolean | null }

/**
 * Bring back the WhatsApp Web sessions that are not connected. Never
 * throws: this runs beside other work and must not break it.
 */
export async function recoverBridgeChannels(
  db: SupabaseClient,
  opts: { accountId?: string; limit?: number; now?: Date } = {},
): Promise<RecoveryResult> {
  const result: RecoveryResult = { checked: 0, reconnected: 0, restarted: 0, needScan: 0, failed: 0 }
  const now = opts.now ?? new Date()
  try {
    const before = new Date(now.getTime() - RECOVERY_EVERY_MS).toISOString()
    let query = db
      .from('whatsapp_config')
      .select('*')
      .eq('provider', 'waha')
      .neq('status', 'connected')
      .eq('bridge_keep_stopped', false)
      .not('bridge_session', 'is', null)
      .not('bridge_base_url', 'is', null)
      .or(`bridge_recovery_at.is.null,bridge_recovery_at.lt.${before}`)
    if (opts.accountId) query = query.eq('account_id', opts.accountId)
    const { data, error } = await query.order('bridge_recovery_at', { ascending: true, nullsFirst: true }).limit(opts.limit ?? 10)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Row[]
    if (rows.length === 0) return result
    const blocked = await blockedAccountIds()

    for (const row of rows) {
      if (blocked.has(row.account_id)) continue
      // Claim it, so two callers at the same moment do not both restart it.
      const { data: claimed } = await db
        .from('whatsapp_config')
        .update({ bridge_recovery_at: now.toISOString() })
        .eq('id', row.id)
        .or(`bridge_recovery_at.is.null,bridge_recovery_at.lt.${before}`)
        .select('id')
      if (!claimed || claimed.length === 0) continue
      result.checked++

      try {
        const client = createWahaClient({ baseUrl: row.bridge_base_url!, apiKey: decrypt(row.access_token) })
        const name = row.bridge_session!
        let info
        try {
          info = await client.getSession(name)
        } catch (err) {
          if (err instanceof WahaError && err.status === 404) {
            // Gone from the bridge: only linking the number again helps.
            await db.from('whatsapp_config').update({ bridge_status: 'STOPPED', status: 'disconnected' }).eq('id', row.id)
            result.needScan++
            continue
          }
          throw err
        }

        const status = (info.status || '').toUpperCase()
        const since = now.getTime() - Date.parse(row.updated_at ?? '') || Number.POSITIVE_INFINITY
        // The row can be stale; decide from what the bridge says now.
        const step = recoveryStep(status, status === (row.bridge_status ?? '').toUpperCase() ? since : 0)

        if (step === 'start' || step === 'restart') {
          if (step === 'start') await client.startSession(name)
          else await client.restartSession(name)
          await db
            .from('whatsapp_config')
            .update({ bridge_status: 'STARTING', status: 'disconnected', updated_at: now.toISOString() })
            .eq('id', row.id)
          result.restarted++
          console.info(`[bridge keep-alive] ${step} of session for channel ${row.id} (was ${status})`)
        } else if (step === 'sync') {
          await db.from('whatsapp_config').update(sessionPatch(info)).eq('id', row.id)
          if (status === 'WORKING') result.reconnected++
          else if (status === 'SCAN_QR_CODE') result.needScan++
        }
      } catch (err) {
        result.failed++
        console.warn(`[bridge keep-alive] channel ${row.id}:`, err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    console.warn('[bridge keep-alive] not run:', err instanceof Error ? err.message : err)
  }
  return result
}
