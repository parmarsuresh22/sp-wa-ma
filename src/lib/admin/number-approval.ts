// ============================================================
// Does a WhatsApp Web number need the platform admin's approval?
//
// One switch for the whole platform, kept in internal_settings and
// changed on the admin page. On (the default): a customer's request
// waits for the admin. Off: the request is approved by itself the
// moment it is made, and the customer goes straight to the QR code.
// The plan's number limit applies either way.
//
// Server-only; takes the service-role client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const WEB_NUMBER_APPROVAL_KEY = 'web_number_approval'

/** True unless the admin switched approval off. Any read error keeps it on. */
export async function numberApprovalRequired(db: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('internal_settings')
      .select('value')
      .eq('key', WEB_NUMBER_APPROVAL_KEY)
      .maybeSingle()
    if (error || !data) return true
    return (data as { value?: string | null }).value !== 'off'
  } catch {
    return true
  }
}

export async function setNumberApproval(db: SupabaseClient, required: boolean): Promise<void> {
  const { error } = await db
    .from('internal_settings')
    .upsert(
      { key: WEB_NUMBER_APPROVAL_KEY, value: required ? 'on' : 'off', updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
  if (error) throw new Error(error.message)
}
